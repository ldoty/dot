# Molly at molly@dot-y.co (api/molly.mjs, bundled by `npm run build`): the mail gate in platform/email
# checks the message and the sender, then invokes this as the member whose verified email sent it. She runs
# the archive's own code as that person (held to a borrowed token's writes), reads attachments with a reader
# that has no tools, files with the archive's tools, and answers in the thread from molly@.
#
# Her role: the archive's table and the family's groups, the files (save into f/, read f/ and text/; never
# delete), Claude on Bedrock, sending from molly@ only, and reading the mail the gate hands her (molly/).
# Apply this before platform/email, which reads /family/archive/molly-worker.
#
# The same code and role run a daily sweep (molly.sweep): a week after an email's attachments arrive,
# what's still in Inbox/ goes to Unsorted/, and she says so once in the thread, counted toward the
# daily limit on what Dot-y sends unasked. For that the role also counts sends and checks membership.

variable "model" {
  type        = string
  default     = "us.anthropic.claude-opus-4-6-v1"
  description = "Claude on Bedrock for Molly (Opus 4.7+ needs AWS approval first)."
}

locals {
  molly_address = "molly@${var.domain_name}"
}

data "archive_file" "molly" {
  type        = "zip"
  output_path = "${path.module}/.build/molly.zip"
  source {
    content  = file("${path.module}/../api/dist/molly.mjs")
    filename = "molly.mjs"
  }
}

resource "aws_iam_role" "molly" {
  name = "family-archive-molly"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
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
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"], Resource = aws_dynamodb_table.main.arn },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = nonsensitive(data.aws_ssm_parameter.people_table_arn.value) },
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject"], Resource = "${aws_s3_bucket.files.arn}/f/*" },
      { Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.files.arn}/text/*" },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.files.arn },
      # The messages the gate hands her (platform/email's mail bucket, prefix molly/), and nothing else there
      { Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::dot-y-mail-*/molly/*" },
      {
        Effect    = "Allow"
        Action    = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource  = "arn:aws:ses:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:identity/${var.domain_name}"
        Condition = { StringEquals = { "ses:FromAddress" = local.molly_address } }
      },
      # The sweep: the daily limit on what Dot-y sends unasked (tools/sms), and whether they're still a member
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Resource = nonsensitive(data.aws_ssm_parameter.sends_table_arn.value) },
      # A sort's summary goes to their account's verified email (ListUsers by sub)
      { Effect = "Allow", Action = "cognito-idp:ListUsers", Resource = "arn:aws:cognito-idp:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:userpool/${local.pool_id}" },
      { Effect = "Allow", Action = "cognito-idp:AdminListGroupsForUser", Resource = "arn:aws:cognito-idp:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:userpool/${local.pool_id}" },
      {
        # us.* inference profiles route to any US region, so allow the models there too
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:*:${data.aws_caller_identity.current.account_id}:inference-profile/us.anthropic.*",
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
        ]
      },
    ]
  })
}

resource "aws_lambda_function" "molly" {
  function_name    = "family-archive-molly"
  role             = aws_iam_role.molly.arn
  runtime          = "nodejs22.x"
  handler          = "molly.handler"
  filename         = data.archive_file.molly.output_path
  source_code_hash = data.archive_file.molly.output_base64sha256
  timeout          = 900 # a sort: up to 200 documents read, then filed in turns of 40
  memory_size      = 1024

  environment {
    variables = {
      TABLE               = aws_dynamodb_table.main.name
      GROUP               = module.app.member_group
      ISSUER              = local.issuer
      CLIENT_ID           = module.app.client_id
      DELEGATED_CLIENT_ID = module.app.delegated_client_id
      PEOPLE_TABLE        = element(split("/", nonsensitive(data.aws_ssm_parameter.people_table_arn.value)), 1)
      BUCKET              = aws_s3_bucket.files.id
      MODEL               = var.model
      MOLLY_ADDRESS       = local.molly_address
      USER_POOL_ID        = local.pool_id
    }
  }
}

# Every morning (10:00 New York in winter, 11:00 in summer): what's waited a week in Inbox/
resource "aws_lambda_function" "molly_sweep" {
  function_name    = "family-archive-molly-sweep"
  role             = aws_iam_role.molly.arn
  runtime          = "nodejs22.x"
  handler          = "molly.sweep"
  filename         = data.archive_file.molly.output_path
  source_code_hash = data.archive_file.molly.output_base64sha256
  timeout          = 300
  memory_size      = 512
  environment {
    variables = merge(aws_lambda_function.molly.environment[0].variables, {
      SENDS_TABLE = element(split("/", nonsensitive(data.aws_ssm_parameter.sends_table_arn.value)), 1)
    })
  }
}

resource "aws_cloudwatch_log_group" "molly_sweep" {
  name              = "/aws/lambda/${aws_lambda_function.molly_sweep.function_name}"
  retention_in_days = 30
}

resource "aws_cloudwatch_event_rule" "molly_sweep" {
  name                = "family-archive-molly-sweep"
  description         = "Move what's waited a week in Inbox/ to Unsorted/, and tell them"
  schedule_expression = "cron(0 15 * * ? *)"
}

resource "aws_cloudwatch_event_target" "molly_sweep" {
  rule = aws_cloudwatch_event_rule.molly_sweep.name
  arn  = aws_lambda_function.molly_sweep.arn
}

resource "aws_lambda_permission" "molly_sweep" {
  statement_id  = "AllowDaily"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.molly_sweep.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.molly_sweep.arn
}

# The daily limit on what Dot-y sends unasked (tools/sms/infra/sends.tf; apply that first)
data "aws_ssm_parameter" "sends_table_arn" {
  name = "/family/sms/sends-table-arn"
}

# One try: a retry would file and answer twice
resource "aws_lambda_function_event_invoke_config" "molly" {
  function_name                = aws_lambda_function.molly.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600
}

resource "aws_cloudwatch_log_group" "molly" {
  name              = "/aws/lambda/${aws_lambda_function.molly.function_name}"
  retention_in_days = 30
}

# Read by platform/email: only its gate may invoke Molly
resource "aws_ssm_parameter" "molly_worker" {
  name  = "/family/archive/molly-worker"
  type  = "String"
  value = aws_lambda_function.molly.arn
}

output "molly_worker" { value = aws_lambda_function.molly.arn }
