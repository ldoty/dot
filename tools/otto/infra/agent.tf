# Otto's own API (api/agent.mjs), on this API at /agent/*: what the agent at home calls. It can't sign in,
# so these routes have no authorizer; the Lambda checks the x-otto-key header against the SecureString
# below (set by hand, never in tofu state; also in the container's /etc/otto/agent-key):
#   aws ssm put-parameter --profile ldoty --type SecureString --name /family/otto/agent-key --value "$(openssl rand -hex 32)"
# Its role can use this table, read that key, look up the owner's verified email, count against the
# daily send limit, and send email only as otto@, nothing else. The agent holds no AWS credentials.

locals {
  agent_key_param = "/family/otto/agent-key"
  agent_routes    = ["POST /agent/next", "POST /agent/commands/{id}", "POST /agent/send"]
}

# The daily limit on what Dot-y sends unasked (tools/sms/infra/sends.tf; apply that first)
data "aws_ssm_parameter" "sends_table_arn" {
  name = "/family/sms/sends-table-arn"
}

data "archive_file" "agent" {
  type        = "zip"
  output_path = "${path.module}/.build/agent.zip"
  source {
    content  = file("${path.module}/../api/agent.mjs")
    filename = "agent.mjs"
  }
  source {
    content  = file("${path.module}/../api/store.mjs")
    filename = "store.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/send-limit.mjs")
    filename = "send-limit.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/mail-thread.mjs")
    filename = "mail-thread.mjs"
  }
}

resource "aws_iam_role" "agent" {
  name = "family-otto-agent"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "agent_logs" {
  role       = aws_iam_role.agent.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "agent" {
  role = aws_iam_role.agent.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"], Resource = aws_dynamodb_table.main.arn },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Resource = nonsensitive(data.aws_ssm_parameter.sends_table_arn.value) },
      {
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.agent_key_param}"
      },
      {
        # The owner's verified email: the only address Otto sends to
        Effect   = "Allow"
        Action   = "cognito-idp:AdminGetUser"
        Resource = "arn:aws:cognito-idp:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:userpool/${local.pool_id}"
      },
      {
        # SendEmail with raw content (threaded replies) is authorized as SendRawEmail
        Effect    = "Allow"
        Action    = ["ses:SendRawEmail", "ses:SendEmail"]
        Resource  = "*"
        Condition = { StringEquals = { "ses:FromAddress" = local.otto_address } }
      },
    ]
  })
}

resource "aws_lambda_function" "agent" {
  function_name    = "family-otto-agent"
  role             = aws_iam_role.agent.arn
  runtime          = "nodejs22.x"
  handler          = "agent.handler"
  filename         = data.archive_file.agent.output_path
  source_code_hash = data.archive_file.agent.output_base64sha256
  timeout          = 15
  memory_size      = 256
  environment {
    variables = {
      TABLE           = aws_dynamodb_table.main.name
      OWNER           = var.owner
      OTTO_ADDRESS    = local.otto_address
      AGENT_KEY_PARAM = local.agent_key_param
      USER_POOL_ID    = local.pool_id
      SENDS_TABLE     = element(split("/", nonsensitive(data.aws_ssm_parameter.sends_table_arn.value)), 1)
      TIME_ZONE       = local.time_zone
    }
  }
}

resource "aws_cloudwatch_log_group" "agent" {
  name              = "/aws/lambda/${aws_lambda_function.agent.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_integration" "agent" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.agent.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "agent" {
  for_each  = toset(local.agent_routes)
  api_id    = aws_apigatewayv2_api.api.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.agent.id}"
}

resource "aws_lambda_permission" "agent" {
  statement_id  = "AllowOttoAgent"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/POST/agent/*"
}
