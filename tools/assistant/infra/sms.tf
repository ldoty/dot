# Dot by text: the worker that runs one turn for a texted question and sends the reply through
# Twilio (api/sms.mjs). Only the SMS webhook (tools/sms) invokes it, after checking Twilio's
# signature, the number's opt-in and the person's family_assistant membership. It runs as Dot's
# own role, so it reaches exactly what the web page does, plus the Twilio credentials.

locals {
  twilio_param = "/family/sms/twilio"                 # SecureString set by hand (platform/api/twilio.mjs)
  sms_bundle   = "${path.module}/../api/dist/sms.mjs" # npm run build
}

data "archive_file" "sms" {
  type        = "zip"
  output_path = "${path.module}/.build/sms.zip"
  source {
    content  = file(local.sms_bundle)
    filename = "sms.mjs"
  }
}

resource "aws_iam_role_policy" "sms" {
  name = "twilio"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "ssm:GetParameter"
      Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.twilio_param}"
    }]
  })
}

resource "aws_lambda_function" "sms" {
  function_name    = "lukes-assistant-sms"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "sms.handler"
  filename         = data.archive_file.sms.output_path
  source_code_hash = data.archive_file.sms.output_base64sha256
  timeout          = 300
  memory_size      = 512
  # One turn at a time: two quick texts would otherwise append to the same conversation at once.
  # Waiting invocations queue (async), they aren't dropped.
  reserved_concurrent_executions = 1

  environment {
    variables = merge(aws_lambda_function.api.environment[0].variables, { TWILIO_PARAM = local.twilio_param })
  }
}

# Never run a turn twice (a retry would answer twice and repeat calendar changes), and don't answer
# a text that has waited in the queue for more than 15 minutes.
resource "aws_lambda_function_event_invoke_config" "sms" {
  function_name                = aws_lambda_function.sms.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 900
}

resource "aws_cloudwatch_log_group" "sms" {
  name              = "/aws/lambda/${aws_lambda_function.sms.function_name}"
  retention_in_days = 30
}

# tools/sms grants its webhook role lambda:InvokeFunction on this, and nothing else may invoke it
resource "aws_ssm_parameter" "sms_worker" {
  name  = "/family/assistant/sms-worker"
  type  = "String"
  value = aws_lambda_function.sms.arn
}

output "sms_worker" { value = aws_lambda_function.sms.arn }
