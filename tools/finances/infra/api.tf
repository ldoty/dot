# One bundle (npm run build), two functions: the page's API and the nightly sync.
# Access: Cognito only issues this app's tokens to the group's members, API Gateway and the
# Lambda both check them, and the role reaches only this table, this tool's SimpleFIN secret,
# its own signing key (to read Budget as its person, read-only) and Bedrock.

locals {
  routes = [
    "GET /month/{month}", "PUT /transactions/{id}", "PUT /accounts/{id}",
    "PUT /settings", "POST /sync", "GET /export/{month}", "GET /dot", "GET /shared/{from}",
  ]
  bundle          = "${path.module}/../api/dist/index.mjs" # npm run build
  simplefin_param = "/family/${var.tool}/simplefin"
}

data "aws_caller_identity" "current" {}

# This tool's signing key, made in core (delegation_signers), and where Budget's delegated client is
data "aws_ssm_parameter" "signer_key" {
  name = "/family/core/signers/${local.name}"
}

data "aws_ssm_parameter" "budget" {
  name = "/family/delegation/family_budget"
}

# The SimpleFIN secret. Paste a setup token (or an access URL) over the placeholder in the
# console: the first sync claims a setup token and stores the access URL in its place.
resource "aws_ssm_parameter" "simplefin" {
  name = local.simplefin_param
  # Straight apostrophes: a changed description would rewrite this SecureString (and its value)
  description = "SimpleFIN Bridge setup token or access URL for ${replace(var.title, "’", "'")}"
  type        = "SecureString"
  value       = "paste-simplefin-setup-token-or-access-url" # simplefin.mjs PLACEHOLDER
  lifecycle { ignore_changes = [value] }
}

# Shared: where each personal tool is (its API and delegated client, published for Dot and this)
data "aws_ssm_parameter" "source" {
  for_each = { for s in var.sources : s.app => s }
  name     = "/family/delegation/${each.key}"
}

data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.build/api.zip"
  source {
    content  = file(local.bundle)
    filename = "index.mjs"
  }
}

resource "aws_iam_role" "api" {
  name = "${local.prefix}-api"
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
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.main.arn
      },
      {
        # Read the secret; write it once, when a setup token is swapped for its access URL
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter"]
        Resource = aws_ssm_parameter.simplefin.arn
      },
      {
        # Only this tool may sign as its group; core decides whom that may act for
        Effect   = "Allow"
        Action   = "kms:Sign"
        Resource = data.aws_ssm_parameter.signer_key.value
      },
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = "arn:aws:lambda:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:function:${local.prefix}-sync"
      },
      {
        # us.* inference profiles route to any US region, so allow the models there too
        Effect = "Allow"
        Action = "bedrock:InvokeModel"
        Resource = [
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/global.anthropic.*",
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
        ]
      },
    ]
  })
}

locals {
  lambda_env = {
    TABLE           = aws_dynamodb_table.main.name
    GROUP           = module.app.member_group
    ISSUER          = local.issuer
    CLIENT_ID       = module.app.client_id
    DOT_CLIENT_ID   = module.app.delegated_client_id
    SIMPLEFIN_PARAM = local.simplefin_param
    SIGNER          = local.name
    SIGNER_KEY      = data.aws_ssm_parameter.signer_key.value
    BUDGET          = data.aws_ssm_parameter.budget.value
    PERSON          = var.person # whose budget (Budget's doc name), or shared
    MODE            = var.mode
    SOURCES         = jsonencode([for s in var.sources : merge(s, jsondecode(data.aws_ssm_parameter.source[s.app].value))])
    PARTITION       = var.partition
    TITLE           = var.title
    TOOL            = var.tool
    OWNER_SUB       = var.owner == null ? "" : var.owner.sub
    OWNER_USERNAME  = var.owner == null ? "" : var.owner.username
    MODEL           = var.model
    TIME_ZONE       = "America/New_York"
    SYNC_FUNCTION   = "${local.prefix}-sync"
  }
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.prefix}-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "index.api"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 25 # changing the tag re-reads the budget
  memory_size      = 512
  environment { variables = local.lambda_env }
}

resource "aws_lambda_function" "sync" {
  function_name    = "${local.prefix}-sync"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "index.sync"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 300
  memory_size      = 512
  environment { variables = local.lambda_env }
}

resource "aws_cloudwatch_log_group" "api" {
  for_each          = { api = aws_lambda_function.api.function_name, sync = aws_lambda_function.sync.function_name }
  name              = "/aws/lambda/${each.value}"
  retention_in_days = 30
}

# Nightly, early morning in New York (SimpleFIN Bridge refreshes from the banks about once a day)
resource "aws_iam_role" "scheduler" {
  name = "${local.prefix}-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.sync.arn }]
  })
}

resource "aws_scheduler_schedule" "sync" {
  name                         = "${local.prefix}-sync"
  schedule_expression          = var.schedule
  schedule_expression_timezone = "America/New_York"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = aws_lambda_function.sync.arn
    role_arn = aws_iam_role.scheduler.arn
    retry_policy { maximum_retry_attempts = 0 }
  }
}

resource "aws_apigatewayv2_api" "api" {
  name          = local.prefix
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = [trimsuffix(local.app_url, "/"), trimsuffix(local.dev_url, "/")]
    allow_methods = ["GET", "PUT", "POST"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 600
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.api.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = local.issuer
    audience = [module.app.client_id, module.app.delegated_client_id]
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api" {
  for_each           = toset(local.routes)
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowToolApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# Where Dot finds this tool (tools/assistant/api/discovery.mjs)
resource "aws_ssm_parameter" "delegation" {
  name        = "/family/delegation/${local.name}"
  description = "${var.title} API and delegated client, for Dot and Shared Finances"
  type        = "String"
  value = jsonencode({
    api_url   = aws_apigatewayv2_api.api.api_endpoint
    client_id = module.app.delegated_client_id
  })
}
