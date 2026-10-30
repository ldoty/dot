# Bulk uploads (POST /batches, api/bulk.mjs bundled by `npm run build`): the API hands out an hour's
# credentials as the uploader role, narrowed by a session policy to one batch's prefix
# (incoming/<sub>/<batchId>/); each file landing there starts the bulk Lambda, which hashes it (never
# opens it), registers it as the batch's maker, and copies it to f/, where intake reads it.

# Only the archive's API may become it, and even then the session policy keeps each batch to its prefix
resource "aws_iam_role" "uploader" {
  name = "family-archive-uploader"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { AWS = aws_iam_role.api.arn }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "uploader" {
  role = aws_iam_role.uploader.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:PutObject", Resource = "${aws_s3_bucket.files.arn}/incoming/*" },
      { Effect = "Allow", Action = "kms:GenerateDataKey", Resource = aws_kms_key.files.arn },
    ]
  })
}

data "archive_file" "bulk" {
  type        = "zip"
  output_path = "${path.module}/.build/bulk.zip"
  source {
    content  = file("${path.module}/../api/dist/bulk.mjs")
    filename = "bulk.mjs"
  }
}

resource "aws_iam_role" "bulk" {
  name = "family-archive-bulk"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "bulk_logs" {
  role       = aws_iam_role.bulk.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# The archive's rows and the family's groups (it runs the archive's upload code as the batch's maker),
# read what landed in incoming/, copy it into f/. Never a delete.
resource "aws_iam_role_policy" "bulk" {
  role = aws_iam_role.bulk.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"], Resource = aws_dynamodb_table.main.arn },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = nonsensitive(data.aws_ssm_parameter.people_table_arn.value) },
      { Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.files.arn}/incoming/*" },
      { Effect = "Allow", Action = "s3:PutObject", Resource = "${aws_s3_bucket.files.arn}/f/*" },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.files.arn },
    ]
  })
}

resource "aws_lambda_function" "bulk" {
  function_name    = "family-archive-bulk"
  role             = aws_iam_role.bulk.arn
  runtime          = "nodejs22.x"
  handler          = "bulk.handler"
  filename         = data.archive_file.bulk.output_path
  source_code_hash = data.archive_file.bulk.output_base64sha256
  timeout          = 120 # hashing a 100 MB file
  memory_size      = 512
  # A big folder arrives a few at a time, so intake (5 at once) isn't swamped
  reserved_concurrent_executions = 5

  environment {
    variables = {
      TABLE               = aws_dynamodb_table.main.name
      GROUP               = module.app.member_group
      ISSUER              = local.issuer
      CLIENT_ID           = module.app.client_id
      DELEGATED_CLIENT_ID = module.app.delegated_client_id
      PEOPLE_TABLE        = element(split("/", nonsensitive(data.aws_ssm_parameter.people_table_arn.value)), 1)
      BUCKET              = aws_s3_bucket.files.id
    }
  }
}

resource "aws_cloudwatch_log_group" "bulk" {
  name              = "/aws/lambda/${aws_lambda_function.bulk.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "bulk" {
  statement_id   = "AllowS3"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.bulk.function_name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.files.arn
  source_account = data.aws_caller_identity.current.account_id
}
