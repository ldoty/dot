locals {
  routes = [
    "GET /home", "GET /dot", "POST /commands",
    "GET /access", "PUT /grants/{id}", "DELETE /grants/{id}", "GET /log",
    "GET /automations", "POST /automations", "PUT /automations/{id}", "PATCH /automations/{id}", "DELETE /automations/{id}", "GET /sent",
  ]
}

# The tool's handler plus the platform's shared token check
data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.build/api.zip"
  source {
    content  = file("${path.module}/../api/api.mjs")
    filename = "api.mjs"
  }
  source {
    content  = file("${path.module}/../api/grants.mjs")
    filename = "grants.mjs"
  }
  source {
    content  = file("${path.module}/../api/access.mjs")
    filename = "access.mjs"
  }
  source {
    content  = file("${path.module}/../api/automations.mjs")
    filename = "automations.mjs"
  }
  source {
    content  = file("${path.module}/../relay/automation.mjs")
    filename = "automation.mjs"
  }
  source {
    content  = file("${path.module}/../api/notify.mjs")
    filename = "notify.mjs"
  }
  source {
    content  = file("${path.module}/../relay/repeat.mjs")
    filename = "repeat.mjs"
  }
  source {
    content  = file("${path.module}/../api/send-limit.mjs")
    filename = "send-limit.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/twilio.mjs")
    filename = "twilio.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/people.mjs")
    filename = "people.mjs"
  }
  source {
    content  = file("${path.module}/../relay/protocol.mjs")
    filename = "protocol.mjs"
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

# The family's groups and names (platform/family): read only
data "aws_ssm_parameter" "people_table_arn" {
  name = "/family/people/table-arn"
}

resource "aws_iam_role" "api" {
  name = "family-house-api"
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
    Statement = [
      {
        # Reads everything; writes only confirmations (PENDING), the audit trail (CMD#…),
        # automations and, for admins, grants
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = aws_dynamodb_table.main.arn
      },
      {
        Effect    = "Allow"
        Action    = ["dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource  = aws_dynamodb_table.main.arn
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["PENDING", "CMD#*", "GRANT", "AUTO"] } }
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:Query"]
        Resource = nonsensitive(data.aws_ssm_parameter.people_table_arn.value)
      },
      {
        # Who is in this tool's group and its admins' (read only): the access pickers, and whether an
        # automation's owner may still run it
        Effect   = "Allow"
        Action   = "cognito-idp:ListUsersInGroup"
        Resource = "arn:aws:cognito-idp:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:userpool/${local.pool_id}"
      },
      {
        # Hand a command or the automations to the relay's connection; nothing else on that API
        Effect   = "Allow"
        Action   = "execute-api:ManageConnections"
        Resource = "${aws_apigatewayv2_api.relay.execution_arn}/${aws_apigatewayv2_stage.relay.name}/POST/@connections/*"
      },
    ]
  })
}

resource "aws_lambda_function" "api" {
  function_name    = "family-house-api"
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
      USER_POOL_ID  = local.pool_id
      # The house's time zone (Home Assistant's): an automation's days and its next run
      TIME_ZONE    = "America/New_York"
      PEOPLE_TABLE = element(split("/", nonsensitive(data.aws_ssm_parameter.people_table_arn.value)), 1)
      # API Gateway's management endpoint for the relay's connection (https, not wss)
      RELAY_ENDPOINT = "https://${aws_apigatewayv2_api.relay.id}.execute-api.${data.aws_region.current.region}.amazonaws.com/${aws_apigatewayv2_stage.relay.name}"
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "api" {
  name          = "family-house"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = [trimsuffix(local.app_url, "/"), trimsuffix(local.dev_url, "/")]
    allow_methods = ["GET", "POST", "PUT", "DELETE"]
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
  description = "House API and delegated client, for Dot"
  type        = "String"
  value = jsonencode({
    api_url   = aws_apigatewayv2_api.api.api_endpoint
    client_id = module.app.delegated_client_id
  })
}

# Every 5 minutes, send the relay the automations that may run now (api/automations.mjs). Changes
# here and to grants are sent at once; this catches what the API doesn't see happen, like someone
# leaving family_house, and a relay that has just reconnected. Same code and role as the API.
resource "aws_lambda_function" "publish" {
  function_name    = "family-house-publish"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "api.publish"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 20
  memory_size      = 256

  environment {
    variables = aws_lambda_function.api.environment[0].variables
  }
}

resource "aws_cloudwatch_log_group" "publish" {
  name              = "/aws/lambda/${aws_lambda_function.publish.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_event_rule" "publish" {
  name                = "family-house-publish"
  description         = "Send the house relay the automations that may run"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "publish" {
  rule = aws_cloudwatch_event_rule.publish.name
  arn  = aws_lambda_function.publish.arn
}

resource "aws_lambda_permission" "publish" {
  statement_id  = "AllowSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.publish.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.publish.arn
}
