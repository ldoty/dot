# Dot-y texting program: the public opt-in endpoint behind dot-y.co/sms, the table of consent
# records, and Twilio's inbound-text webhook (webhook.tf) that hands texts to Dot.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
  backend "s3" {
    bucket       = "family-tfstate-921782276410"
    key          = "tools/sms/terraform.tfstate"
    region       = "us-east-1"
    profile      = "ldoty"
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "ldoty"
  default_tags { tags = { project = "family", root = "sms" } }
}

variable "site_origin" {
  type    = string
  default = "https://dot-y.co"
}

locals {
  # SecureString set by hand: { accountSid, authToken, messagingServiceSid } (platform/api/twilio.mjs)
  twilio_param = "/family/sms/twilio"
  twilio_arn   = "arn:aws:ssm:us-east-1:${data.aws_caller_identity.current.account_id}:parameter${local.twilio_param}"
}

data "aws_caller_identity" "current" {}

# Consent records are proof of opt-in: protected from deletion and backed up continuously.
resource "aws_dynamodb_table" "consent" {
  name                        = "dot-y-sms-consent"
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

data "archive_file" "optin" {
  type        = "zip"
  output_path = "${path.module}/.build/optin.zip"
  source {
    content  = file("${path.module}/../api/optin.mjs")
    filename = "optin.mjs"
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

resource "aws_iam_role" "optin" {
  name = "dot-y-sms-optin"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "optin_logs" {
  role       = aws_iam_role.optin.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Write-only: the public endpoint can add consent records but never read them back. It sends
# a number's one opt-in confirmation (a conditional put decides, so no read is needed).
resource "aws_iam_role_policy" "optin" {
  role = aws_iam_role.optin.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "dynamodb:PutItem", Resource = aws_dynamodb_table.consent.arn },
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = local.twilio_arn },
    ]
  })
}

resource "aws_lambda_function" "optin" {
  function_name    = "dot-y-sms-optin"
  role             = aws_iam_role.optin.arn
  runtime          = "nodejs22.x"
  handler          = "optin.handler"
  filename         = data.archive_file.optin.output_path
  source_code_hash = data.archive_file.optin.output_base64sha256
  timeout          = 10
  memory_size      = 256
  environment {
    variables = { TABLE = aws_dynamodb_table.consent.name, TWILIO_PARAM = local.twilio_param }
  }
}

resource "aws_cloudwatch_log_group" "optin" {
  name              = "/aws/lambda/${aws_lambda_function.optin.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "api" {
  name          = "dot-y-sms"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = [var.site_origin]
    allow_methods = ["POST"]
    allow_headers = ["content-type"]
    max_age       = 600
  }
}

resource "aws_apigatewayv2_integration" "optin" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.optin.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "optin" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "POST /optin"
  target    = "integrations/${aws_apigatewayv2_integration.optin.id}"
}

# Public form: keep abuse cheap and slow
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 5
    throttling_rate_limit  = 2
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowSmsApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.optin.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# platform/core reads this to wire the /sms form
resource "aws_ssm_parameter" "optin_url" {
  name  = "/family/sms/optin-url"
  type  = "String"
  value = "${aws_apigatewayv2_api.api.api_endpoint}/optin"
}

output "optin_url" { value = "${aws_apigatewayv2_api.api.api_endpoint}/optin" }
output "table" { value = aws_dynamodb_table.consent.name }
