# Texts an automation's owner when it runs (api/notify.mjs), invoked only by the relay Lambda
# (asynchronously, never retried). Same code as the API; its own role: read this table, write only
# its once-per-run rows and the audit trail, see who's in House and its admins, read a person's
# verified phone, and use Twilio's sending key.

locals {
  twilio_param = "/family/sms/twilio" # SecureString set by hand (platform/api/twilio.mjs)
}

resource "aws_iam_role" "notify" {
  name = "family-house-notify"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "notify_logs" {
  role       = aws_iam_role.notify.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "notify" {
  role = aws_iam_role.notify.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = aws_dynamodb_table.main.arn },
      {
        Effect    = "Allow"
        Action    = "dynamodb:PutItem"
        Resource  = aws_dynamodb_table.main.arn
        Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["NOTIFIED", "CMD#*"] } }
      },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = nonsensitive(data.aws_ssm_parameter.people_table_arn.value) },
      {
        # Who's in House and its admins (whether the owner may still run it), and the owner's verified phone
        Effect   = "Allow"
        Action   = ["cognito-idp:ListUsersInGroup", "cognito-idp:AdminGetUser"]
        Resource = "arn:aws:cognito-idp:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:userpool/${local.pool_id}"
      },
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.twilio_param}" },
    ]
  })
}

resource "aws_lambda_function" "notify" {
  function_name    = "family-house-notify"
  role             = aws_iam_role.notify.arn
  runtime          = "nodejs22.x"
  handler          = "api.notify"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 20
  memory_size      = 256

  environment {
    variables = merge(aws_lambda_function.api.environment[0].variables, { TWILIO_PARAM = local.twilio_param })
  }
}

# A text is never retried (it would arrive twice), and one that waited over 10 minutes is old news
resource "aws_lambda_function_event_invoke_config" "notify" {
  function_name                = aws_lambda_function.notify.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 600
}

resource "aws_cloudwatch_log_group" "notify" {
  name              = "/aws/lambda/${aws_lambda_function.notify.function_name}"
  retention_in_days = 30
}
