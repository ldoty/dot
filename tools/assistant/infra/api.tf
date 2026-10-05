# The assistant runs behind a Lambda Function URL with response streaming (API Gateway
# can't stream and caps requests at 30s; a turn with several tool calls can take longer).
# Access: Cognito only issues this app's tokens to family_assistant members, the Lambda
# verifies every token itself, and its role reaches only its table, its Google key and Bedrock.

variable "model" {
  type    = string
  default = "us.anthropic.claude-opus-4-6-v1"
  # Opus 5.5 (global.anthropic.claude-opus-5-5) answers "not available for this account" until
  # AWS approves the account for Opus 4.7+; switch back here once it does.
}

variable "fallback_model" {
  type        = string
  default     = ""
  description = "Retried when the main model declines (client-side; Bedrock has no server-side fallback). Empty = off; Opus 4.6 on Bedrock Runtime rejects the fallback's beta flag, so set this only with Opus 4.7+."
}

variable "people" {
  type = map(object({
    name      = string
    calendars = optional(map(string), {}) # alias => Google calendar id (shared with Dot's service account)
  }))
  description = "Who Dot is talking with, by Cognito sub (the user's id in the pool): their name and their calendars"
  default = {
    "44f8c468-4011-70b8-76aa-ec2b68b0b004" = {
      name = "Luke"
      calendars = {
        luke   = "luke.doty@gmail.com"
        shared = "19ktvn2rmaupk99h546rtjhh54@group.calendar.google.com"
        amber  = "amber.n.brackett@gmail.com" # "Amber Master Calendar", shared read-only
      }
    }
    "74c8b418-e0b1-7075-7ae5-ca791980dd07" = {
      name      = "Amber"
      calendars = { amber = "amber.n.brackett@gmail.com" }
    }
  }
}

# Dot reads these tools for whoever asks, with that person's own access (platform/api/delegation.mjs)
data "aws_ssm_parameter" "delegation_key" {
  name = "/family/core/delegation-key-arn"
}

data "aws_ssm_parameter" "budget" {
  name = "/family/delegation/family_budget"
}

locals {
  google_key_param = "/family/calendar/google-key"
  bundle           = "${path.module}/../api/dist/index.mjs" # npm run build
}

data "aws_caller_identity" "current" {}

data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.build/api.zip"
  source {
    content  = file(local.bundle)
    filename = "index.mjs"
  }
}

resource "aws_iam_role" "api" {
  name = "lukes-assistant-api"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "api" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.main.arn
      },
      {
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.google_key_param}"
      },
      {
        # Discovery: the family tools published for Dot (/family/delegation/<app> = API + delegated client)
        Effect   = "Allow"
        Action   = "ssm:GetParametersByPath"
        Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/family/delegation"
      },
      {
        # Only Dot may vouch for someone; the trigger checks this key's signature
        Effect   = "Allow"
        Action   = "kms:Sign"
        Resource = data.aws_ssm_parameter.delegation_key.value
      },
      {
        # us.* inference profiles route to any US region, so allow the models there too
        Effect = "Allow"
        Action = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
        Resource = [
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/global.anthropic.*",
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
        ]
      },
    ]
  })
}

resource "aws_lambda_function" "api" {
  function_name    = "lukes-assistant-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 300
  memory_size      = 512

  environment {
    variables = {
      TABLE            = aws_dynamodb_table.main.name
      GROUP            = module.app.member_group
      ISSUER           = local.issuer
      CLIENT_ID        = module.app.client_id
      MODEL            = var.model
      FALLBACK_MODEL   = var.fallback_model
      GOOGLE_KEY_PARAM = local.google_key_param
      PEOPLE           = jsonencode(var.people)
      DELEGATION_KEY   = data.aws_ssm_parameter.delegation_key.value
      BUDGET           = data.aws_ssm_parameter.budget.value
      DELEGATION_PATH  = "/family/delegation"
      TIME_ZONE        = "America/New_York"
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE" # tokens are verified inside the function
  invoke_mode        = "RESPONSE_STREAM"
  cors {
    allow_origins = [trimsuffix(local.app_url, "/"), trimsuffix(local.dev_url, "/")]
    allow_methods = ["GET", "POST", "DELETE"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 600
  }
}

resource "aws_lambda_permission" "url" {
  statement_id           = "AllowFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# Function URLs also need InvokeFunction, limited here to calls that come through the URL
resource "aws_lambda_permission" "url_invoke" {
  statement_id             = "AllowInvokeViaFunctionUrl"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.api.function_name
  principal                = "*"
  invoked_via_function_url = true
}
