# The sweep (api/sweep.mjs): every minute, one at a time, queue the schedules that are due and mark
# commands the agent stopped answering as failed. In AWS, so schedules are queued even while home is down.
# Its role can use this table, nothing else.

data "archive_file" "sweep" {
  type        = "zip"
  output_path = "${path.module}/.build/sweep.zip"
  source {
    content  = file("${path.module}/../api/sweep.mjs")
    filename = "sweep.mjs"
  }
  source {
    content  = file("${path.module}/../api/store.mjs")
    filename = "store.mjs"
  }
  source {
    content  = file("${path.module}/../api/schedules.mjs")
    filename = "schedules.mjs"
  }
  source {
    content  = file("${path.module}/../../lists/api/repeat.mjs")
    filename = "repeat.mjs"
  }
}

resource "aws_iam_role" "sweep" {
  name = "family-otto-sweep"
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
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"], Resource = aws_dynamodb_table.main.arn }]
  })
}

resource "aws_lambda_function" "sweep" {
  function_name                  = "family-otto-sweep"
  role                           = aws_iam_role.sweep.arn
  runtime                        = "nodejs22.x"
  handler                        = "sweep.handler"
  filename                       = data.archive_file.sweep.output_path
  source_code_hash               = data.archive_file.sweep.output_base64sha256
  timeout                        = 50 # always done before the next minute's run
  memory_size                    = 256
  reserved_concurrent_executions = 1 # never two sweeps at once
  environment {
    variables = { TABLE = aws_dynamodb_table.main.name }
  }
}

resource "aws_cloudwatch_log_group" "sweep" {
  name              = "/aws/lambda/${aws_lambda_function.sweep.function_name}"
  retention_in_days = 30
}

resource "aws_cloudwatch_event_rule" "sweep" {
  name                = "family-otto-sweep"
  description         = "Queue Otto's schedules that are due"
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
