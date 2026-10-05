# househunt@dot-y.co: listing alerts go here. dot-y.co's MX already points at SES (platform/email);
# this adds a rule to its receipt rule set that stores these messages in this tool's own bucket and
# hands them to the ingest Lambda, which has Claude file the listings (see api/ingest.mjs).

variable "model" {
  type    = string
  default = "us.anthropic.claude-opus-4-6-v1"
  # The newest Claude this account can use on Bedrock (like the assistant); Opus 4.7+ answers
  # "not available for this account" until AWS approves it. Then: global.anthropic.claude-opus-5-5
}

variable "allowed_senders" {
  type        = list(string)
  description = "Who may email listings in: full addresses, or domains (which include their subdomains). Mail must also pass DMARC."
  default = [
    "luke.doty@gmail.com", "amber.n.brackett@gmail.com",
    "zillow.com", "redfin.com", "realtor.com", "move.com", "homes.com", "trulia.com",
  ]
}

locals {
  mail_address = "househunt@${var.domain_name}"
  ingest_build = "${path.module}/../api/dist/ingest.mjs" # npm run build
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "mail" {
  bucket_prefix = "family-house-hunt-mail-"
}

resource "aws_s3_bucket_public_access_block" "mail" {
  bucket                  = aws_s3_bucket.mail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "mail" {
  bucket = aws_s3_bucket.mail.id
  rule {
    id     = "expire-after-90-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

resource "aws_s3_bucket_policy" "mail" {
  bucket = aws_s3_bucket.mail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ses.amazonaws.com" }
      Action    = "s3:PutObject"
      Resource  = "${aws_s3_bucket.mail.arn}/inbound/*"
      Condition = { StringEquals = { "AWS:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

data "archive_file" "ingest" {
  type        = "zip"
  output_path = "${path.module}/.build/ingest.zip"
  source {
    content  = file(local.ingest_build)
    filename = "ingest.mjs"
  }
}

resource "aws_iam_role" "ingest" {
  name = "family-house-hunt-ingest"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ingest_logs" {
  role       = aws_iam_role.ingest.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "ingest" {
  role = aws_iam_role.ingest.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.mail.arn}/inbound/*" },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"], Resource = aws_dynamodb_table.main.arn },
      {
        # us.* inference profiles route to any US region, so allow the models there too
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.*",
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/global.anthropic.*",
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
        ]
      },
    ]
  })
}

resource "aws_lambda_function" "ingest" {
  function_name    = "family-house-hunt-ingest"
  role             = aws_iam_role.ingest.arn
  runtime          = "nodejs22.x"
  handler          = "ingest.handler"
  filename         = data.archive_file.ingest.output_path
  source_code_hash = data.archive_file.ingest.output_base64sha256
  timeout          = 300
  memory_size      = 512
  # One email at a time, so two alerts about the same house don't race
  reserved_concurrent_executions = 1

  environment {
    variables = {
      TABLE           = aws_dynamodb_table.main.name
      BUCKET          = aws_s3_bucket.mail.id
      PREFIX          = "inbound/"
      MODEL           = var.model
      ALLOWED_SENDERS = join(",", var.allowed_senders)
    }
  }
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${aws_lambda_function.ingest.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "ses" {
  statement_id   = "AllowSES"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.ingest.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_ses_receipt_rule" "ingest" {
  name          = "house-hunt-listings"
  rule_set_name = "dot-y" # platform/email
  recipients    = [local.mail_address]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Optional"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.mail.id
    object_key_prefix = "inbound/"
  }

  lambda_action {
    position        = 2
    function_arn    = aws_lambda_function.ingest.arn
    invocation_type = "Event"
  }

  depends_on = [aws_s3_bucket_policy.mail, aws_lambda_permission.ses]
}
