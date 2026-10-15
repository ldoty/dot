# Dot by email (dot@dot-y.co): the worker that reads one message, runs the turn as its sender and
# replies (api/email.mjs). Only platform/email's gate invokes it, after checking SES's verdicts and
# that the sender is the verified email of a family_assistant member. It runs as Dot's own role, so
# it reaches exactly what the web page does, plus reading dot/ in the mail bucket (granted by that
# bucket's policy in platform/email) and sending from dot@dot-y.co only.

locals {
  dot_address  = "dot@${var.domain_name}"
  email_bundle = "${path.module}/../api/dist/email.mjs" # npm run build
}

data "archive_file" "email" {
  type        = "zip"
  output_path = "${path.module}/.build/email.zip"
  source {
    content  = file(local.email_bundle)
    filename = "email.mjs"
  }
}

resource "aws_iam_role_policy" "email" {
  name = "email"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = ["ses:SendEmail", "ses:SendRawEmail"]
      Resource  = "arn:aws:ses:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:identity/${var.domain_name}"
      Condition = { StringEquals = { "ses:FromAddress" = local.dot_address } }
    }]
  })
}

resource "aws_lambda_function" "email" {
  function_name    = "lukes-assistant-email"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "email.handler"
  filename         = data.archive_file.email.output_path
  source_code_hash = data.archive_file.email.output_base64sha256
  timeout          = 300
  memory_size      = 1024 # a message with photos is parsed in memory
  # One turn at a time, like texting: two quick replies in a thread would otherwise race
  reserved_concurrent_executions = 1

  environment {
    variables = merge(aws_lambda_function.api.environment[0].variables, { DOT_ADDRESS = local.dot_address })
  }
}

# Never run a turn twice (a retry would answer twice and repeat calendar changes)
resource "aws_lambda_function_event_invoke_config" "email" {
  function_name                = aws_lambda_function.email.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600
}

resource "aws_cloudwatch_log_group" "email" {
  name              = "/aws/lambda/${aws_lambda_function.email.function_name}"
  retention_in_days = 30
}

# platform/email grants its gate lambda:InvokeFunction on this, and nothing else may invoke it
resource "aws_ssm_parameter" "email_worker" {
  name  = "/family/assistant/email-worker"
  type  = "String"
  value = aws_lambda_function.email.arn
}

output "email_worker" { value = aws_lambda_function.email.arn }
