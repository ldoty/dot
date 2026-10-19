# Reminders (api/sweep.mjs): every minute, one at a time, send what's due by text (the Dot-y
# number, through Twilio) or email (from dot@dot-y.co). In AWS, so reminders don't depend on home.
# Its role can read and write this table, look up a person's verified phone and email, read the
# Twilio sending key, and send email only as dot@.

locals {
  twilio_param = "/family/sms/twilio" # SecureString set by hand (platform/api/twilio.mjs)
  from_address = "dot@${var.domain_name}"
}

data "aws_caller_identity" "current" {}

data "archive_file" "sweep" {
  type        = "zip"
  output_path = "${path.module}/.build/sweep.zip"
  source {
    content  = file("${path.module}/../api/sweep.mjs")
    filename = "sweep.mjs"
  }
  source {
    content  = file("${path.module}/../api/model.mjs")
    filename = "model.mjs"
  }
  source {
    content  = file("${path.module}/../api/repeat.mjs")
    filename = "repeat.mjs"
  }
  source {
    content  = file("${path.module}/../../../platform/api/twilio.mjs")
    filename = "twilio.mjs"
  }
}

resource "aws_iam_role" "sweep" {
  name = "family-lists-sweep"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "sweep_logs" {
  role       = aws_iam_role.sweep.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "sweep" {
  role = aws_iam_role.sweep.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"], Resource = aws_dynamodb_table.main.arn },
      {
        # A person's verified phone and email, nothing else about them
        Effect   = "Allow"
        Action   = "cognito-idp:AdminGetUser"
        Resource = "arn:aws:cognito-idp:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:userpool/${local.pool_id}"
      },
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.twilio_param}" },
      {
        Effect    = "Allow"
        Action    = "ses:SendEmail"
        Resource  = "*"
        Condition = { StringEquals = { "ses:FromAddress" = local.from_address } }
      },
    ]
  })
}

resource "aws_lambda_function" "sweep" {
  function_name                  = "family-lists-sweep"
  role                           = aws_iam_role.sweep.arn
  runtime                        = "nodejs22.x"
  handler                        = "sweep.handler"
  filename                       = data.archive_file.sweep.output_path
  source_code_hash               = data.archive_file.sweep.output_base64sha256
  timeout                        = 50 # always done before the next minute's run
  memory_size                    = 256
  reserved_concurrent_executions = 1 # never two sweeps at once
  environment {
    variables = {
      TABLE        = aws_dynamodb_table.main.name
      USER_POOL_ID = local.pool_id
      TWILIO_PARAM = local.twilio_param
      FROM_ADDRESS = local.from_address
    }
  }
}

resource "aws_cloudwatch_log_group" "sweep" {
  name              = "/aws/lambda/${aws_lambda_function.sweep.function_name}"
  retention_in_days = 30
}

resource "aws_cloudwatch_event_rule" "sweep" {
  name                = "family-lists-sweep"
  description         = "Send Lists reminders that are due"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "sweep" {
  rule = aws_cloudwatch_event_rule.sweep.name
  arn  = aws_lambda_function.sweep.arn
}

resource "aws_lambda_permission" "sweep" {
  statement_id  = "AllowEveryMinute"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sweep.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sweep.arn
}
