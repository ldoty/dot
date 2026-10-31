locals {
  routes = [
    "GET /dot", "GET /status", "GET /commands", "POST /commands", "POST /commands/{id}/approve", "DELETE /commands/{id}",
    "GET /schedules", "POST /schedules", "PATCH /schedules/{id}", "DELETE /schedules/{id}", "GET /sent",
  ]
}

# The person's side (api/api.mjs) plus the shared files it imports
data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.build/api.zip"
  source {
    content  = file("${path.module}/../api/api.mjs")
    filename = "api.mjs"
  }
  source {
    content  = file("${path.module}/../api/store.mjs")
    filename = "store.mjs"
  }
  source {
    content  = file("${path.module}/../api/schedules.mjs")
    filename = "schedules.mjs"
  }
  source {
    content  = file("${path.module}/../../lists/api/repeat.mjs")
    filename = "repeat.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/verify-token.mjs")
    filename = "verify-token.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/dot-manifest.mjs")
    filename = "dot-manifest.mjs"
  }
}

resource "aws_iam_role" "api" {
  name = "family-otto-api"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "api_table" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"]
      Resource = aws_dynamodb_table.main.arn
    }]
  })
}

resource "aws_lambda_function" "api" {
  function_name    = "family-otto-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "api.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      TABLE         = aws_dynamodb_table.main.name
      GROUP         = module.app.member_group
      ISSUER        = local.issuer
      CLIENT_ID     = module.app.client_id
      DOT_CLIENT_ID = module.app.delegated_client_id
      TIME_ZONE     = local.time_zone
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "api" {
  name          = "family-otto"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = [trimsuffix(local.app_url, "/"), trimsuffix(local.dev_url, "/")]
    allow_methods = ["GET", "POST", "PATCH", "DELETE"]
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

# For Dot and Claude Code (platform/mcp): where to find this tool, as the person
resource "aws_ssm_parameter" "delegation" {
  name        = "/family/delegation/${local.name}"
  description = "Otto API and delegated client, for Dot and Claude Code"
  type        = "String"
  value = jsonencode({
    api_url   = aws_apigatewayv2_api.api.api_endpoint
    client_id = module.app.delegated_client_id
  })
}
