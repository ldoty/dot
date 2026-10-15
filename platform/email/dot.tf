# dot@dot-y.co: email Dot. SES stores the message under dot/ in the mail bucket, then the gate
# (lambda/dot.mjs) checks the verdicts, skips automatic mail, and finds the family_assistant member
# whose verified email sent it; only then does it start Dot's email worker (tools/assistant, which
# reads the message, runs the turn as that person, and replies from dot@dot-y.co).
#
# The gate's role can look people up in the user pool and invoke the worker, nothing else. The
# worker runs as Dot's own role; the bucket policy (main.tf) lets it read dot/ only.

locals {
  dot_address = "dot@${var.domain_name}"
}

data "aws_ssm_parameter" "user_pool_id" {
  name = "/family/core/user-pool-id"
}

# Published by tools/assistant (apply that root first)
data "aws_ssm_parameter" "dot_email_worker" {
  name = "/family/assistant/email-worker"
}

data "aws_lambda_function" "dot_email_worker" {
  function_name = data.aws_ssm_parameter.dot_email_worker.value
}

data "archive_file" "dot" {
  type        = "zip"
  source_file = "${path.module}/lambda/dot.mjs"
  output_path = "${path.module}/.build/dot.zip"
}

resource "aws_iam_role" "dot" {
  name = "dot-y-mail-dot"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "dot_logs" {
  role       = aws_iam_role.dot.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "dot" {
  role = aws_iam_role.dot.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["cognito-idp:ListUsers", "cognito-idp:AdminListGroupsForUser"]
        Resource = "arn:aws:cognito-idp:us-east-1:${data.aws_caller_identity.current.account_id}:userpool/${data.aws_ssm_parameter.user_pool_id.value}"
      },
      { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = data.aws_ssm_parameter.dot_email_worker.value },
    ]
  })
}

resource "aws_lambda_function" "dot" {
  function_name    = "dot-y-mail-dot"
  role             = aws_iam_role.dot.arn
  runtime          = "nodejs22.x"
  handler          = "dot.handler"
  filename         = data.archive_file.dot.output_path
  source_code_hash = data.archive_file.dot.output_base64sha256
  timeout          = 30
  memory_size      = 256
  environment {
    variables = {
      DOT_ADDRESS  = local.dot_address
      BUCKET       = aws_s3_bucket.mail.id
      PREFIX       = "dot/"
      USER_POOL_ID = data.aws_ssm_parameter.user_pool_id.value
      GROUP        = "family_assistant"
      WORKER       = data.aws_ssm_parameter.dot_email_worker.value
    }
  }
}

resource "aws_cloudwatch_log_group" "dot" {
  name              = "/aws/lambda/${aws_lambda_function.dot.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "dot_ses" {
  statement_id   = "AllowSES"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.dot.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_ses_receipt_rule" "dot" {
  name          = "dot"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = [local.dot_address]
  enabled       = true
  scan_enabled  = true # the virus and spam verdicts the gate requires
  tls_policy    = "Optional"
  after         = aws_ses_receipt_rule.forward.name

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.mail.id
    object_key_prefix = "dot/"
  }

  lambda_action {
    position        = 2
    function_arn    = aws_lambda_function.dot.arn
    invocation_type = "Event"
  }

  depends_on = [aws_s3_bucket_policy.mail, aws_lambda_permission.dot_ses]
}

output "dot_address" { value = local.dot_address }
