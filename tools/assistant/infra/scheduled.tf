# Scheduled asks (api/scheduled.mjs): every minute, one run at a time, never retried, run each ask that's
# due as its owner (read-only tools only) and text or email them the answer. Same role as the rest of
# Dot (its table, Bedrock, delegation, Twilio's sending key, sending as dot@), plus looking up a
# person's group membership and verified phone and email, so an ask stops when they leave Dot.

locals {
  scheduled_bundle = "${path.module}/../api/dist/scheduled.mjs" # npm run build
}

data "archive_file" "scheduled" {
  type        = "zip"
  output_path = "${path.module}/.build/scheduled.zip"
  source {
    content  = file(local.scheduled_bundle)
    filename = "scheduled.mjs"
  }
}

resource "aws_iam_role_policy" "people" {
  name = "people"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      # Whether someone may still use Dot, and their verified phone and email (read only): for a
      # scheduled ask's run, and for checking where its answers can go when it's made
      Effect   = "Allow"
      Action   = ["cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser"]
      Resource = "arn:aws:cognito-idp:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:userpool/${local.pool_id}"
      }, {
      # Counting each run toward the person's daily limit on what Dot-y sends unasked
      Effect   = "Allow"
      Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
      Resource = nonsensitive(data.aws_ssm_parameter.sends_table_arn.value)
    }]
  })
}

resource "aws_lambda_function" "scheduled" {
  function_name    = "lukes-assistant-scheduled"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "scheduled.handler"
  filename         = data.archive_file.scheduled.output_path
  source_code_hash = data.archive_file.scheduled.output_base64sha256
  timeout          = 300
  memory_size      = 512
  # One at a time: a slow minute holds the next back instead of running the same ask twice
  reserved_concurrent_executions = 1

  environment {
    variables = merge(aws_lambda_function.api.environment[0].variables, {
      TWILIO_PARAM = local.twilio_param
      DOT_ADDRESS  = local.dot_address
      SENDS_TABLE  = element(split("/", nonsensitive(data.aws_ssm_parameter.sends_table_arn.value)), 1)
    })
  }
}

# A run is never retried (it would send the answer twice); a missed minute is caught up by the next
resource "aws_lambda_function_event_invoke_config" "scheduled" {
  function_name                = aws_lambda_function.scheduled.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 120
}

resource "aws_cloudwatch_log_group" "scheduled" {
  name              = "/aws/lambda/${aws_lambda_function.scheduled.function_name}"
  retention_in_days = 30
}

resource "aws_cloudwatch_event_rule" "scheduled" {
  name                = "lukes-assistant-scheduled"
  description         = "Run Dot's scheduled asks that are due"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "scheduled" {
  rule = aws_cloudwatch_event_rule.scheduled.name
  arn  = aws_lambda_function.scheduled.arn
}

resource "aws_lambda_permission" "scheduled" {
  statement_id  = "AllowSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scheduled.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scheduled.arn
}

# The daily limit on what Dot-y sends unasked (tools/sms/infra/sends.tf; apply that first)
data "aws_ssm_parameter" "sends_table_arn" {
  name = "/family/sms/sends-table-arn"
}
