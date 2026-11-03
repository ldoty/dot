# The dot-y MCP server: the family's tools in Claude Code, as the person signed in (api/server.mjs).
#
# Claude Code signs in with this root's client (sign-in page, code + PKCE, back to localhost), for members
# of family_mcp. Then, like Dot, it finds every tool published at /family/delegation/* and borrows a
# short-lived token for the person on each, signed with core's `mcp` signer key (delegation_signers,
# limited there to the people it may act for). A tool takes part only if its family-app `delegates`
# lists "mcp"; it then answers exactly as it would for Dot: reads, and the writes its manifest declares.
#
# Apply core first (the signer key), then this, then add "mcp" to each tool's delegates. Add it to
# Claude Code with the `claude_mcp_add` output, then /mcp to sign in.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
  backend "s3" {
    bucket       = "family-tfstate-921782276410"
    key          = "platform/mcp/terraform.tfstate"
    region       = "us-east-1"
    profile      = "ldoty"
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "ldoty"
  default_tags { tags = { project = "family", root = "mcp" } }
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

data "aws_ssm_parameter" "user_pool_id" {
  name = "/family/core/user-pool-id"
}

data "aws_ssm_parameter" "auth_domain" {
  name = "/family/core/auth-domain"
}

# This server's signing key (core: delegation_signers.mcp)
data "aws_ssm_parameter" "signer_key" {
  name = "/family/core/signers/mcp"
}

locals {
  name    = "family_mcp"
  pool_id = data.aws_ssm_parameter.user_pool_id.value
  issuer  = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${local.pool_id}"
  # Claude Code listens here during sign-in ("callbackPort" in the claude_mcp_add output)
  callback_port = 33419
  callbacks     = ["http://localhost:${local.callback_port}/callback"]
  mcp_routes    = ["POST /mcp", "GET /mcp"]
  # Where Claude Code finds out how to sign in, and the sign-in passed through to the pool's own
  # (platform/api/mcp-auth.mjs): no token, nothing but public metadata and Cognito's own answers
  open_routes = [
    "GET /.well-known/oauth-protected-resource", "GET /.well-known/oauth-protected-resource/mcp",
    "GET /.well-known/oauth-authorization-server", "GET /oauth/authorize", "POST /oauth/token",
  ]
}

# --- Who may sign in, and with what ---

resource "aws_cognito_user_group" "member" {
  user_pool_id = local.pool_id
  name         = local.name
  description  = "Can use the family's tools from Claude Code"
}

# Claude Code's client: sign-in page (code + PKCE, no secret: it runs on a laptop), back to localhost.
# No CUSTOM_AUTH, so neither /handoff nor a signer can mint its tokens.
resource "aws_cognito_user_pool_client" "mcp" {
  name                                 = "${local.name}-claude-code"
  user_pool_id                         = local.pool_id
  generate_secret                      = false
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = local.callbacks
  logout_urls                          = local.callbacks
  prevent_user_existence_errors        = "ENABLED"

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}

resource "aws_cognito_managed_login_branding" "mcp" {
  user_pool_id                = local.pool_id
  client_id                   = aws_cognito_user_pool_client.mcp.id
  use_cognito_provided_values = true
}

# The pre-token gate's rule: members of family_mcp only; never a /handoff destination
resource "aws_ssm_parameter" "access_rule" {
  name        = "/family/apps/${aws_cognito_user_pool_client.mcp.id}"
  description = "Sign-in rule for Claude Code on the family's tools"
  type        = "String"
  value       = jsonencode({ app = local.name, group = local.name, portal = false, returns = [] })
}

# --- The server ---

data "archive_file" "server" {
  type        = "zip"
  output_path = "${path.module}/.build/server.zip"
  source {
    content  = file("${path.module}/api/server.mjs")
    filename = "server.mjs"
  }
  source {
    content  = file("${path.module}/api/connect.mjs")
    filename = "connect.mjs"
  }
  source {
    content  = file("${path.module}/../api/mcp.mjs")
    filename = "mcp.mjs"
  }
  source {
    content  = file("${path.module}/../api/mcp-auth.mjs")
    filename = "mcp-auth.mjs"
  }
  source {
    content  = file("${path.module}/../api/verify-token.mjs")
    filename = "verify-token.mjs"
  }
  source {
    content  = file("${path.module}/../api/delegation.mjs")
    filename = "delegation.mjs"
  }
  source {
    content  = file("${path.module}/../api/dot-manifest.mjs")
    filename = "dot-manifest.mjs"
  }
}

resource "aws_iam_role" "server" {
  name = "family-mcp-server"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "server_logs" {
  role       = aws_iam_role.server.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Sign as `mcp` (core decides whom for, each tool whether to accept it), and see which tools are published.
# No table, no tool's data: everything goes through the tools' own APIs with the person's borrowed token.
resource "aws_iam_role_policy" "server" {
  role = aws_iam_role.server.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "kms:Sign", Resource = data.aws_ssm_parameter.signer_key.value },
      {
        Effect   = "Allow"
        Action   = "ssm:GetParametersByPath"
        Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/family/delegation"
      },
    ]
  })
}

resource "aws_lambda_function" "server" {
  function_name    = "family-mcp-server"
  role             = aws_iam_role.server.arn
  runtime          = "nodejs22.x"
  handler          = "server.handler"
  filename         = data.archive_file.server.output_path
  source_code_hash = data.archive_file.server.output_base64sha256
  timeout          = 29 # API Gateway's limit
  memory_size      = 512

  environment {
    variables = {
      GROUP       = aws_cognito_user_group.member.name
      ISSUER      = local.issuer
      CLIENT_ID   = aws_cognito_user_pool_client.mcp.id
      PUBLIC_URL  = aws_apigatewayv2_api.api.api_endpoint
      AUTH_DOMAIN = data.aws_ssm_parameter.auth_domain.value
      SIGNER_KEY  = data.aws_ssm_parameter.signer_key.value
      # Tools whose changes that ask first (202) are confirmed here. Luke's choice for Otto: its OK is Claude
      # Code's own permission prompt, from `ask` rules on mcp__dot-y__otto_stage and _schedule_* in his
      # settings, which no model can answer. Every other tool's OK stays with Dot or its page.
      CONFIRM_APPS = "lukes_otto"
    }
  }
}

resource "aws_cloudwatch_log_group" "server" {
  name              = "/aws/lambda/${aws_lambda_function.server.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "api" {
  name          = "family-mcp"
  protocol_type = "HTTP"
}

# Claude Code binds its tokens to the MCP URL (RFC 8707), which Cognito puts in `aud`; the authorizer
# checks `aud` when there is one and client_id when there isn't, so it takes both
resource "aws_apigatewayv2_authorizer" "mcp" {
  api_id           = aws_apigatewayv2_api.api.id
  name             = "cognito-mcp"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = local.issuer
    audience = [aws_cognito_user_pool_client.mcp.id, "${aws_apigatewayv2_api.api.api_endpoint}/mcp"]
  }
}

resource "aws_apigatewayv2_integration" "server" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.server.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "mcp" {
  for_each           = toset(local.mcp_routes)
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.server.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.mcp.id
}

resource "aws_apigatewayv2_route" "open" {
  for_each  = toset(local.open_routes)
  api_id    = aws_apigatewayv2_api.api.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.server.id}"
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
  statement_id  = "AllowMcpApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.server.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

output "mcp_url" { value = "${aws_apigatewayv2_api.api.api_endpoint}/mcp" }
output "client_id" { value = aws_cognito_user_pool_client.mcp.id }
# Run once to add the family's tools to Claude Code (any folder), then /mcp to sign in. Its values come
# partly from SSM (so marked sensitive) but none is secret.
output "claude_mcp_add" {
  value = nonsensitive("claude mcp add-json --scope user dot-y '${jsonencode({
    type = "http"
    url  = "${aws_apigatewayv2_api.api.api_endpoint}/mcp"
    oauth = {
      clientId              = aws_cognito_user_pool_client.mcp.id
      callbackPort          = local.callback_port
      scopes                = "openid email profile"
      authServerMetadataUrl = "${aws_apigatewayv2_api.api.api_endpoint}/.well-known/oauth-authorization-server"
    }
  })}'")
}
