# contact@dot-y.co: received by Amazon SES (dot-y.co's MX points here instead of the inactive
# Google Workspace), stored in a private bucket for 90 days, and forwarded to Gmail by a Lambda
# with Reply-To set to the original sender. dot-y.co is a verified SES sending domain (DKIM,
# SPF via a MAIL FROM subdomain, DMARC) so forwarded mail isn't treated as spoofed.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
  backend "s3" {
    bucket       = "family-tfstate-921782276410"
    key          = "platform/email/terraform.tfstate"
    region       = "us-east-1"
    profile      = "ldoty"
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "ldoty"
  default_tags { tags = { project = "family", root = "email" } }
}

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

variable "addresses" {
  type        = map(string)
  description = "Address on the domain => where to forward it"
  default = {
    "contact@dot-y.co" = "luke.doty@gmail.com"
  }
}

data "aws_route53_zone" "main" {
  name = var.domain_name
}

data "aws_caller_identity" "current" {}

# --- Sending identity: DKIM, MAIL FROM (SPF), DMARC ---------------------------------
resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain_name
}

resource "aws_route53_record" "dkim" {
  count   = 3
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = "mail.${var.domain_name}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "mail.${var.domain_name}"
  type    = "MX"
  ttl     = 1800
  records = ["10 feedback-smtp.us-east-1.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "mail.${var.domain_name}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 1800
  records = ["v=DMARC1; p=none; rua=mailto:contact@${var.domain_name}"]
}

# --- Receiving: MX -> SES -------------------------------------------------------------
# Replaces the Google Workspace MX records (Workspace is inactive).
resource "aws_route53_record" "mx" {
  zone_id         = data.aws_route53_zone.main.zone_id
  name            = var.domain_name
  type            = "MX"
  ttl             = 300
  records         = ["10 inbound-smtp.us-east-1.amazonaws.com"]
  allow_overwrite = true
}

resource "aws_s3_bucket" "mail" {
  bucket_prefix = "dot-y-mail-"
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

data "archive_file" "forward" {
  type        = "zip"
  source_file = "${path.module}/lambda/forward.mjs"
  output_path = "${path.module}/.build/forward.zip"
}

resource "aws_iam_role" "forward" {
  name = "dot-y-mail-forward"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "forward_logs" {
  role       = aws_iam_role.forward.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "forward" {
  role = aws_iam_role.forward.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.mail.arn}/inbound/*" },
      { Effect = "Allow", Action = ["ses:SendRawEmail", "ses:SendEmail"], Resource = "*", Condition = { StringEquals = { "ses:FromAddress" = keys(var.addresses) } } },
    ]
  })
}

resource "aws_lambda_function" "forward" {
  function_name    = "dot-y-mail-forward"
  role             = aws_iam_role.forward.arn
  runtime          = "nodejs22.x"
  handler          = "forward.handler"
  filename         = data.archive_file.forward.output_path
  source_code_hash = data.archive_file.forward.output_base64sha256
  timeout          = 30
  memory_size      = 256
  environment {
    variables = {
      BUCKET   = aws_s3_bucket.mail.id
      PREFIX   = "inbound/"
      FORWARDS = jsonencode(var.addresses)
    }
  }
}

resource "aws_cloudwatch_log_group" "forward" {
  name              = "/aws/lambda/${aws_lambda_function.forward.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "ses" {
  statement_id   = "AllowSES"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.forward.function_name
  principal      = "ses.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_ses_receipt_rule_set" "main" {
  rule_set_name = "dot-y"
}

resource "aws_ses_active_receipt_rule_set" "main" {
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
}

resource "aws_ses_receipt_rule" "forward" {
  name          = "store-and-forward"
  rule_set_name = aws_ses_receipt_rule_set.main.rule_set_name
  recipients    = keys(var.addresses)
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
    function_arn    = aws_lambda_function.forward.arn
    invocation_type = "Event"
  }

  depends_on = [aws_s3_bucket_policy.mail, aws_lambda_permission.ses]
}

output "addresses" { value = var.addresses }
output "mail_bucket" { value = aws_s3_bucket.mail.id }
