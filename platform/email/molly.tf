# molly@dot-y.co: email Molly, the archivist (tools/archive). The same gate as dot@ (lambda/dot.mjs, with
# Molly's address, group and worker): SES stores the message under molly/ in the mail bucket, then the gate
# checks the verdicts (DMARC must pass), skips automatic mail, and finds the family_archive member whose
# verified email sent it; only then does it start Molly's worker, which files what's attached and answers
# from molly@ in the same thread.
#
# The gate's role can look people up in the user pool and invoke Molly's worker, nothing else. The
# worker runs as the archive's role for Molly; the bucket policy (main.tf) lets it read molly/ only.

locals {
  molly_address = "molly@${var.domain_name}"
}

# Published by tools/archive (apply that root first)
data "aws_ssm_parameter" "molly_worker" {
  name = "/family/archive/molly-worker"
}

data "aws_lambda_function" "molly_worker" {
  function_name = data.aws_ssm_parameter.molly_worker.value
}

resource "aws_iam_role" "molly" {
  name               = "dot-y-mail-molly"
  assume_role_policy = aws_iam_role.dot.assume_role_policy
}

resource "aws_iam_role_policy_attachment" "molly_logs" {
  role       = aws_iam_role.molly.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "molly" {
  role = aws_iam_role.molly.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["cognito-idp:ListUsers", "cognito-idp:AdminListGroupsForUser"]
        Resource = "arn:aws:cognito-idp:us-east-1:${data.aws_caller_identity.current.account_id}:userpool/${data.aws_ssm_parameter.user_pool_id.value}"
      },
      { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = data.aws_ssm_parameter.molly_worker.value },
      {
        # Addresses members confirmed at dot-y.co/me (platform/family): the EMAIL claims, nothing else there
        Effect    = "Allow"
        Action    = "dynamodb:GetItem"
        Resource  = nonsensitive(data.aws_ssm_parameter.people_table_arn.value)
        Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["EMAIL"] } }
      },
    ]
  })
}

resource "aws_lambda_function" "molly" {
  function_name    = "dot-y-mail-molly"
  role             = aws_iam_role.molly.arn
  runtime          = "nodejs22.x"
  handler          = "dot.handler"
  filename         = data.archive_file.dot.output_path
  source_code_hash = data.archive_file.dot.output_base64sha256
  timeout          = 30
  memory_size      = 256
  environment {
    variables = {
      DOT_ADDRESS  = local.molly_address # the gate's own address, whoever answers it
      BUCKET       = aws_s3_bucket.mail.id
      PREFIX       = "molly/"
      USER_POOL_ID = data.aws_ssm_parameter.user_pool_id.value
      PEOPLE_TABLE = element(split("/", nonsensitive(data.aws_ssm_parameter.people_table_arn.value)), 1)
      GROUP        = "family_archive"
      WORKER       = data.aws_ssm_parameter.molly_worker.value
    }
  }
}

resource "aws_cloudwatch_log_group" "molly" {
  name              = "/aws/lambda/${aws_lambda_function.molly.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "molly_ses" {
  statement_id   = "AllowSES"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.molly.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_ses_receipt_rule" "molly" {
  name          = "molly"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = [local.molly_address]
  enabled       = true
  scan_enabled  = true # the virus and spam verdicts the gate requires
  tls_policy    = "Optional"
  after         = aws_ses_receipt_rule.dot.name

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.mail.id
    object_key_prefix = "molly/"
  }

  lambda_action {
    position        = 2
    function_arn    = aws_lambda_function.molly.arn
    invocation_type = "Event"
  }

  depends_on = [aws_s3_bucket_policy.mail, aws_lambda_permission.molly_ses]
}

output "molly_address" { value = local.molly_address }
