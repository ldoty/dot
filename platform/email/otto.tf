# otto@dot-y.co: email Otto, Luke's agent at home (tools/otto). The same gate as dot@ and molly@ (lambda/dot.mjs,
# with Otto's address, group and worker): SES stores the message under otto/ in the mail bucket, then the gate
# checks the verdicts (DMARC must pass), skips automatic mail, and finds the lukes_otto member whose verified
# email sent it; only then does it start Otto's mail worker, which keeps the words and queues a command.
# Otto answers from otto@ in the same thread, when the agent at home has run it.
#
# The gate's role can look people up in the user pool and invoke Otto's mail worker, nothing else. The
# worker runs as its own role (tools/otto/infra/mail.tf); the bucket policy (main.tf) lets it read otto/ only.

locals {
  otto_address = "otto@${var.domain_name}"
}

# Published by tools/otto (apply that root first)
data "aws_ssm_parameter" "otto_worker" {
  name = "/family/otto/mail-worker"
}

data "aws_lambda_function" "otto_worker" {
  function_name = data.aws_ssm_parameter.otto_worker.value
}

resource "aws_iam_role" "otto" {
  name               = "dot-y-mail-otto"
  assume_role_policy = aws_iam_role.dot.assume_role_policy
}

resource "aws_iam_role_policy_attachment" "otto_logs" {
  role       = aws_iam_role.otto.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "otto" {
  role = aws_iam_role.otto.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["cognito-idp:ListUsers", "cognito-idp:AdminListGroupsForUser"]
        Resource = "arn:aws:cognito-idp:us-east-1:${data.aws_caller_identity.current.account_id}:userpool/${data.aws_ssm_parameter.user_pool_id.value}"
      },
      { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = data.aws_ssm_parameter.otto_worker.value },
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

resource "aws_lambda_function" "otto" {
  function_name    = "dot-y-mail-otto"
  role             = aws_iam_role.otto.arn
  runtime          = "nodejs22.x"
  handler          = "dot.handler"
  filename         = data.archive_file.dot.output_path
  source_code_hash = data.archive_file.dot.output_base64sha256
  timeout          = 30
  memory_size      = 256
  environment {
    variables = {
      DOT_ADDRESS  = local.otto_address # the gate's own address, whoever answers it
      BUCKET       = aws_s3_bucket.mail.id
      PREFIX       = "otto/"
      USER_POOL_ID = data.aws_ssm_parameter.user_pool_id.value
      PEOPLE_TABLE = element(split("/", nonsensitive(data.aws_ssm_parameter.people_table_arn.value)), 1)
      GROUP        = "lukes_otto"
      WORKER       = data.aws_ssm_parameter.otto_worker.value
    }
  }
}

resource "aws_cloudwatch_log_group" "otto" {
  name              = "/aws/lambda/${aws_lambda_function.otto.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "otto_ses" {
  statement_id   = "AllowSES"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.otto.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_ses_receipt_rule" "otto" {
  name          = "otto"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = [local.otto_address]
  enabled       = true
  scan_enabled  = true # the virus and spam verdicts the gate requires
  tls_policy    = "Optional"
  after         = aws_ses_receipt_rule.molly.name

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.mail.id
    object_key_prefix = "otto/"
  }

  lambda_action {
    position        = 2
    function_arn    = aws_lambda_function.otto.arn
    invocation_type = "Event"
  }

  depends_on = [aws_s3_bucket_policy.mail, aws_lambda_permission.otto_ses]
}

output "otto_address" { value = local.otto_address }
