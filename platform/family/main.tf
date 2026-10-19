# The family's groups and display names, one place for every tool (platform/api/people.mjs reads
# them; api/api.mjs, for family admins at dot-y.co/family, writes them). A tool's grants name a
# group by id. Who may use a tool at all stays with that tool's Cognito group: nothing here can
# change it (the API may only list users).
#
# Publishes /family/people/table-arn (tools grant themselves read on it) and /family/people/api-url
# (core's dot-y.co/family page). Apply this before core.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
  backend "s3" {
    bucket       = "family-tfstate-921782276410"
    key          = "platform/family/terraform.tfstate"
    region       = "us-east-1"
    profile      = "ldoty"
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "ldoty"
  default_tags { tags = { project = "family", root = "family" } }
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_ssm_parameter" "user_pool_id" {
  name = "/family/core/user-pool-id"
}

data "aws_ssm_parameter" "home_client_id" {
  name = "/family/core/home-client-id"
}

locals {
  pool_id = data.aws_ssm_parameter.user_pool_id.value
  issuer  = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${local.pool_id}"
  origins = ["https://dot-y.co", "http://localhost:5173"]
  routes  = ["GET /people", "PUT /people/{sub}", "PUT /groups/{id}", "DELETE /groups/{id}"]
}

# Rows: GROUP / <id> { name, members, rev }, PERSON / <sub> { name } (platform/api/people.mjs)
resource "aws_dynamodb_table" "people" {
  name                        = "family-people"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle { prevent_destroy = true }
}

data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.build/api.zip"
  source {
    content  = file("${path.module}/api/api.mjs")
    filename = "api.mjs"
  }
  source {
    content  = file("${path.module}/../api/verify-token.mjs")
    filename = "verify-token.mjs"
  }
  source {
    content  = file("${path.module}/../api/people.mjs")
    filename = "people.mjs"
  }
}

resource "aws_iam_role" "api" {
  name = "family-people-api"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
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
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"], Resource = aws_dynamodb_table.people.arn },
      {
        # Listing accounts for the member picker; no permission to change users or their groups
        Effect   = "Allow"
        Action   = "cognito-idp:ListUsers"
        Resource = "arn:aws:cognito-idp:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:userpool/${local.pool_id}"
      },
    ]
  })
}

resource "aws_lambda_function" "api" {
  function_name    = "family-people-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "api.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 10
  memory_size      = 256
  environment {
    variables = {
      TABLE        = aws_dynamodb_table.people.name
      ISSUER       = local.issuer
      CLIENT_ID    = data.aws_ssm_parameter.home_client_id.value
      USER_POOL_ID = local.pool_id
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "api" {
  name          = "family-people"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = local.origins
    allow_methods = ["GET", "PUT", "DELETE"]
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
    audience = [data.aws_ssm_parameter.home_client_id.value]
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
    throttling_burst_limit = 10
    throttling_rate_limit  = 5
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowFamilyApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_ssm_parameter" "table_arn" {
  name        = "/family/people/table-arn"
  description = "The family-people table, for tools to read groups and names (platform/api/people.mjs)"
  type        = "String"
  value       = aws_dynamodb_table.people.arn
}

resource "aws_ssm_parameter" "api_url" {
  name        = "/family/people/api-url"
  description = "The family API, for dot-y.co/family"
  type        = "String"
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "api_url" { value = aws_apigatewayv2_api.api.api_endpoint }
output "table" { value = aws_dynamodb_table.people.name }
