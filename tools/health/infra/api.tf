locals {
  routes = ["GET /all", "PUT /settings", "PUT /plan", "PUT /exercises/{id}", "DELETE /exercises/{id}", "PUT /workouts/{id}", "DELETE /workouts/{id}", "PUT /sessions/{id}", "DELETE /sessions/{id}", "PUT /weights/{date}", "DELETE /weights/{date}", "PUT /journal/{date}", "PUT /food/{id}", "DELETE /food/{id}", "POST /starter", "GET /dot", "GET /dot/summary", "GET /dot/sessions", "GET /dot/exercise", "GET /dot/workouts", "GET /dot/journal", "GET /dot/food", "POST /dot/log", "POST /dot/food", "POST /dot/journal"]
}

# The tool's handler, its starter program, what it tells Dot, and the platform's shared token check and manifest rules
data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.build/api.zip"
  source {
    content  = file("${path.module}/../api/api.mjs")
    filename = "api.mjs"
  }
  source {
    content  = file("${path.module}/../api/starter.mjs")
    filename = "starter.mjs"
  }
  source {
    content  = file("${path.module}/../api/dot.mjs")
    filename = "dot.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/dot-manifest.mjs")
    filename = "dot-manifest.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/verify-token.mjs")
    filename = "verify-token.mjs"
  }
}

resource "aws_iam_role" "api" {
  name = "family-health-api"
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
  function_name    = "family-health-api"
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
      TZ_HOME       = "America/New_York" # "today" for Dot's summary and logs
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "api" {
  name          = "family-health"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = [trimsuffix(local.app_url, "/"), trimsuffix(local.dev_url, "/")]
    allow_methods = ["GET", "PUT", "POST", "DELETE"]
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
  description = "Health API and delegated client, for Dot"
  type        = "String"
  value = jsonencode({
    api_url   = aws_apigatewayv2_api.api.api_endpoint
    client_id = module.app.delegated_client_id
  })
}
