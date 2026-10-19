# The relay's way in (api/relay-ws.mjs): a WebSocket API the relay at home dials out to, so no
# port is open at home. The relay can't sign in, so $connect has no authorizer: the Lambda checks
# the device key (x-house-key header) against the SecureString below. Set it by hand, so it never
# sits in tofu state, and put the same value in the relay's /etc/house-relay/house-key:
#
#   aws ssm put-parameter --profile ldoty --type SecureString \
#     --name /family/house/relay-key --value "$(openssl rand -hex 32)"
#
# Its role can read that key and write what the house reports and how commands and automations went:
# nothing else.

locals {
  relay_key_param = "/family/house/relay-key"
  relay_key_arn   = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.relay_key_param}"
  relay_routes    = ["$connect", "$disconnect", "sync", "result", "ran", "$default"]
}

data "aws_caller_identity" "current" {}

data "archive_file" "relay" {
  type        = "zip"
  output_path = "${path.module}/.build/relay.zip"
  source {
    content  = file("${path.module}/../api/relay-ws.mjs")
    filename = "relay-ws.mjs"
  }
  source {
    content  = file("${path.module}/../relay/protocol.mjs")
    filename = "protocol.mjs"
  }
  source {
    content  = file("${path.module}/../relay/automation.mjs")
    filename = "automation.mjs"
  }
}

resource "aws_iam_role" "relay" {
  name = "family-house-relay"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "relay_logs" {
  role       = aws_iam_role.relay.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "relay" {
  role = aws_iam_role.relay.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Only the rows the house reports, its connection, and command results
        Effect    = "Allow"
        Action    = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
        Resource  = aws_dynamodb_table.main.arn
        Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["RELAY", "AREA", "ENTITY", "RESULT"] } }
      },
      {
        # How automations ran: their last run and the audit trail (adding rows only)
        Effect    = "Allow"
        Action    = "dynamodb:PutItem"
        Resource  = aws_dynamodb_table.main.arn
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["RAN", "CMD#*"] } }
      },
      {
        # Whose automation it was, for the audit row
        Effect    = "Allow"
        Action    = "dynamodb:GetItem"
        Resource  = aws_dynamodb_table.main.arn
        Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["AUTO"] } }
      },
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = local.relay_key_arn },
    ]
  })
}

resource "aws_lambda_function" "relay" {
  function_name    = "family-house-relay"
  role             = aws_iam_role.relay.arn
  runtime          = "nodejs22.x"
  handler          = "relay-ws.handler"
  filename         = data.archive_file.relay.output_path
  source_code_hash = data.archive_file.relay.output_base64sha256
  timeout          = 10
  memory_size      = 256
  environment {
    variables = {
      TABLE           = aws_dynamodb_table.main.name
      RELAY_KEY_PARAM = local.relay_key_param
    }
  }
}

resource "aws_cloudwatch_log_group" "relay" {
  name              = "/aws/lambda/${aws_lambda_function.relay.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "relay" {
  name                       = "family-house-relay"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.type"
}

resource "aws_apigatewayv2_integration" "relay" {
  api_id             = aws_apigatewayv2_api.relay.id
  integration_type   = "AWS_PROXY"
  integration_uri    = aws_lambda_function.relay.invoke_arn
  integration_method = "POST"
}

resource "aws_apigatewayv2_route" "relay" {
  for_each  = toset(local.relay_routes)
  api_id    = aws_apigatewayv2_api.relay.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.relay.id}"
}

resource "aws_apigatewayv2_stage" "relay" {
  api_id      = aws_apigatewayv2_api.relay.id
  name        = "live"
  auto_deploy = true
  default_route_settings {
    # One relay: a change batch a second plus a snapshot every 5 minutes is far under this
    throttling_burst_limit = 20
    throttling_rate_limit  = 5
  }
}

resource "aws_lambda_permission" "relay" {
  statement_id  = "AllowRelayApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.relay.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.relay.execution_arn}/*/*"
}

output "relay_url" { value = aws_apigatewayv2_stage.relay.invoke_url }
