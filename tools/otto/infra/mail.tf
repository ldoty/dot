# Mail to otto@dot-y.co (api/mail.mjs, bundled by `npm run build` for mailparser): the gate in
# platform/email (otto.tf) invokes it for a lukes_otto member's DMARC-passing mail; it keeps the words
# and queues a command. Its role can read otto/ in the mail bucket (the bucket's policy, platform/email)
# and use this table. Apply this root before platform/email: the gate reads the worker's name from SSM.

resource "aws_iam_role" "mail" {
  name = "family-otto-mail"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "mail_logs" {
  role       = aws_iam_role.mail.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "mail" {
  role = aws_iam_role.mail.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:GetItem"], Resource = aws_dynamodb_table.main.arn }]
  })
}

data "archive_file" "mail" {
  type        = "zip"
  source_file = "${path.module}/../api/dist/mail.mjs"
  output_path = "${path.module}/.build/mail.zip"
}

resource "aws_lambda_function" "mail" {
  function_name    = "family-otto-mail"
  role             = aws_iam_role.mail.arn
  runtime          = "nodejs22.x"
  handler          = "mail.handler"
  filename         = data.archive_file.mail.output_path
  source_code_hash = data.archive_file.mail.output_base64sha256
  timeout          = 30
  memory_size      = 512
  environment {
    variables = {
      TABLE = aws_dynamodb_table.main.name
      OWNER = var.owner
    }
  }
}

resource "aws_cloudwatch_log_group" "mail" {
  name              = "/aws/lambda/${aws_lambda_function.mail.function_name}"
  retention_in_days = 30
}

# Read by platform/email: only its gate may invoke it, and the bucket lets its role read otto/.
# A retry is harmless: the MAIL row is written only once (store.mjs putAt), so a message queues once.
resource "aws_ssm_parameter" "mail_worker" {
  name  = "/family/otto/mail-worker"
  type  = "String"
  value = aws_lambda_function.mail.arn
}
