# The chamber board's telemetry endpoint (api/ingest.mjs), on this API at POST /ingest.
# The Arduino can't sign in, so the route has no authorizer: the Lambda checks the device key
# (x-chamber-key header) against the SecureString below. Set it by hand, so it never sits in
# tofu state, and put the same value in firmware/chamber_telemetry/arduino_secrets.h:
#
#   aws ssm put-parameter --profile ldoty --type SecureString \
#     --name /family/chamber/device-key --value "$(openssl rand -hex 32)"
#
# Its role can read that key, read the desired settings and write readings: nothing else.

locals {
  device_key_param = "/family/chamber/device-key"
  device_key_arn   = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.device_key_param}"
}

data "aws_caller_identity" "current" {}

data "archive_file" "ingest" {
  type        = "zip"
  output_path = "${path.module}/.build/ingest.zip"
  source {
    content  = file("${path.module}/../api/ingest.mjs")
    filename = "ingest.mjs"
  }
  source {
    content  = file("${path.module}/../api/settings.mjs")
    filename = "settings.mjs"
  }
}

resource "aws_iam_role" "ingest" {
  name = "family-chamber-ingest"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ingest_logs" {
  role       = aws_iam_role.ingest.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ingest" {
  role = aws_iam_role.ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Resource = aws_dynamodb_table.main.arn },
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = local.device_key_arn },
    ]
  })
}

resource "aws_lambda_function" "ingest" {
  function_name    = "family-chamber-ingest"
  role             = aws_iam_role.ingest.arn
  runtime          = "nodejs22.x"
  handler          = "ingest.handler"
  filename         = data.archive_file.ingest.output_path
  source_code_hash = data.archive_file.ingest.output_base64sha256
  timeout          = 5 # the board stops listening for the reply long before this
  memory_size      = 256
  environment {
    variables = {
      TABLE            = aws_dynamodb_table.main.name
      DEVICE_KEY_PARAM = local.device_key_param
      LOCAL_TZ         = "America/New_York" # the chamber's wall clock, for its light schedule (TZ is reserved in Lambda)
    }
  }
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${aws_lambda_function.ingest.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_integration" "ingest" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.ingest.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "ingest" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "POST /ingest"
  target    = "integrations/${aws_apigatewayv2_integration.ingest.id}"
}

resource "aws_lambda_permission" "ingest" {
  statement_id  = "AllowChamberIngest"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/POST/ingest"
}
