# Intake (api/intake.mjs, bundled by `npm run build`): every new file is checked, its text read and it is
# filed. The file is untrusted and the parser third-party, so this role is the narrowest in the tool:
# read f/, write text/, read and write catalog rows. No Bedrock, no mail, never a delete.

data "archive_file" "intake" {
  type        = "zip"
  output_path = "${path.module}/.build/intake.zip"
  source {
    content  = file("${path.module}/../api/dist/intake.mjs")
    filename = "intake.mjs"
  }
}

resource "aws_iam_role" "intake" {
  name = "family-archive-intake"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "intake_logs" {
  role       = aws_iam_role.intake.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "intake" {
  role = aws_iam_role.intake.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Resource = aws_dynamodb_table.main.arn },
      { Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.files.arn}/f/*" },
      { Effect = "Allow", Action = "s3:PutObject", Resource = "${aws_s3_bucket.files.arn}/text/*" },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.files.arn },
    ]
  })
}

resource "aws_lambda_function" "intake" {
  function_name    = "family-archive-intake"
  role             = aws_iam_role.intake.arn
  runtime          = "nodejs22.x"
  handler          = "intake.handler"
  filename         = data.archive_file.intake.output_path
  source_code_hash = data.archive_file.intake.output_base64sha256
  timeout          = 120  # a long PDF
  memory_size      = 1536 # pdf.js holds the whole document
  # A few at a time: a folder of uploads waits its turn rather than running up concurrency
  reserved_concurrent_executions = 5

  environment {
    variables = {
      TABLE  = aws_dynamodb_table.main.name
      BUCKET = aws_s3_bucket.files.id
    }
  }
}

resource "aws_cloudwatch_log_group" "intake" {
  name              = "/aws/lambda/${aws_lambda_function.intake.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "intake" {
  statement_id   = "AllowS3"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.intake.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.files.arn
  source_account = data.aws_caller_identity.current.account_id
}
