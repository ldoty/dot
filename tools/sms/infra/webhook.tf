# Twilio's inbound-text webhook (api/webhook.mjs), on this API at POST /twilio. Set it as the
# Messaging Service's incoming-message URL (output twilio_webhook_url). Twilio signs every request;
# the Lambda checks the signature itself, so the route has no authorizer.
#
# Its role can read and add consent records (opt-in state; STOP and START), look a number up in the
# user pool (only a verified phone_number in family_assistant counts), and start Dot's SMS worker.

data "aws_ssm_parameter" "user_pool_id" {
  name = "/family/core/user-pool-id"
}

# Published by tools/assistant (apply that root first)
data "aws_ssm_parameter" "sms_worker" {
  name = "/family/assistant/sms-worker"
}

data "archive_file" "webhook" {
  type        = "zip"
  output_path = "${path.module}/.build/webhook.zip"
  source {
    content  = file("${path.module}/../api/webhook.mjs")
    filename = "webhook.mjs"
  }
  source {
    content  = file("${path.module}/../api/program.mjs")
    filename = "program.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/twilio.mjs")
    filename = "twilio.mjs"
  }
}

resource "aws_iam_role" "webhook" {
  name = "dot-y-sms-webhook"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "webhook_logs" {
  role       = aws_iam_role.webhook.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "webhook" {
  role = aws_iam_role.webhook.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:Query", "dynamodb:PutItem"], Resource = aws_dynamodb_table.consent.arn },
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = local.twilio_arn },
      {
        Effect   = "Allow"
        Action   = ["cognito-idp:ListUsers", "cognito-idp:AdminListGroupsForUser"]
        Resource = "arn:aws:cognito-idp:us-east-1:${data.aws_caller_identity.current.account_id}:userpool/${data.aws_ssm_parameter.user_pool_id.value}"
      },
      { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = data.aws_ssm_parameter.sms_worker.value },
    ]
  })
}

resource "aws_lambda_function" "webhook" {
  function_name    = "dot-y-sms-webhook"
  role             = aws_iam_role.webhook.arn
  runtime          = "nodejs22.x"
  handler          = "webhook.handler"
  filename         = data.archive_file.webhook.output_path
  source_code_hash = data.archive_file.webhook.output_base64sha256
  timeout          = 10 # Twilio waits 15 seconds; the turn itself runs in Dot's worker
  memory_size      = 256
  environment {
    variables = {
      TABLE        = aws_dynamodb_table.consent.name
      TWILIO_PARAM = local.twilio_param
      USER_POOL_ID = data.aws_ssm_parameter.user_pool_id.value
      GROUP        = "family_assistant"
      WORKER       = data.aws_ssm_parameter.sms_worker.value
    }
  }
}

resource "aws_cloudwatch_log_group" "webhook" {
  name              = "/aws/lambda/${aws_lambda_function.webhook.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_integration" "webhook" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.webhook.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "POST /twilio"
  target    = "integrations/${aws_apigatewayv2_integration.webhook.id}"
}

resource "aws_lambda_permission" "webhook" {
  statement_id  = "AllowSmsApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/POST/twilio"
}

output "twilio_webhook_url" { value = "${aws_apigatewayv2_api.api.api_endpoint}/twilio" }
