locals {
  # The page's routes: its own client's tokens (none yet; the page comes with the catalog)
  routes = []
  # Claude Code's: the MCP client's tokens
  mcp_routes = ["POST /mcp", "GET /mcp"]
  # Where Claude Code finds out how to sign in (RFC 9728): no token, nothing but public metadata
  # and its sign-in, passed through to the pool's own for the MCP client only (platform/api/mcp-auth.mjs)
  open_routes = [
    "GET /.well-known/oauth-protected-resource", "GET /.well-known/oauth-protected-resource/mcp",
    "GET /.well-known/oauth-authorization-server", "GET /oauth/authorize", "POST /oauth/token",
  ]
}

# The tool's handler plus the platform's shared token check and MCP server
data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.build/api.zip"
  source {
    content  = file("${path.module}/../api/api.mjs")
    filename = "api.mjs"
  }
  source {
    content  = file("${path.module}/../api/tools.mjs")
    filename = "tools.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/verify-token.mjs")
    filename = "verify-token.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/mcp.mjs")
    filename = "mcp.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/mcp-auth.mjs")
    filename = "mcp-auth.mjs"
  }
}

resource "aws_iam_role" "api" {
  name = "family-archive-api"
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
  function_name    = "family-archive-api"
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
      MCP_CLIENT_ID = module.app.mcp_client_id
      PUBLIC_URL    = aws_apigatewayv2_api.api.api_endpoint
      AUTH_DOMAIN   = data.aws_ssm_parameter.auth_domain.value
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "api" {
  name          = "family-archive"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = [trimsuffix(local.app_url, "/"), trimsuffix(local.dev_url, "/")]
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
    audience = [module.app.client_id]
  }
}

# Claude Code's tokens get their own authorizer, so they reach /mcp and nothing else. Claude Code asks
# for a token bound to the MCP URL (RFC 8707 `resource`), and Cognito puts that URL in `aud`; the
# authorizer checks `aud` when there is one and client_id only when there isn't, so it takes both.
resource "aws_apigatewayv2_authorizer" "mcp" {
  api_id           = aws_apigatewayv2_api.api.id
  name             = "cognito-mcp"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = local.issuer
    audience = [module.app.mcp_client_id, "${aws_apigatewayv2_api.api.api_endpoint}/mcp"]
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

resource "aws_apigatewayv2_route" "mcp" {
  for_each           = toset(local.mcp_routes)
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.mcp.id
}

resource "aws_apigatewayv2_route" "open" {
  for_each  = toset(local.open_routes)
  api_id    = aws_apigatewayv2_api.api.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
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
