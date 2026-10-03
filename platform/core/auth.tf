locals {
  auth_domain = "auth.${var.domain_name}"
}

resource "aws_cognito_user_pool" "family" {
  name                     = "family-users"
  user_pool_tier           = "ESSENTIALS"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = "ACTIVE"

  username_configuration {
    case_sensitive = false
  }

  # Invite-only: you add people with scripts/invite.sh.
  admin_create_user_config {
    allow_admin_create_user_only = true
    invite_message_template {
      email_subject = "You're invited to ${var.domain_name}"
      email_message = join("", [
        "You've been invited to the family site at ${local.home_url}<br><br>",
        "Sign in with <b>{username}</b> and temporary password <b>{####}</b> ",
        "(you'll pick your own password after). This invite expires in 7 days.",
      ])
      sms_message = "Your ${var.domain_name} username is {username} and temporary password is {####}"
    }
  }

  password_policy {
    minimum_length                   = 10
    require_lowercase                = false
    require_uppercase                = false
    require_numbers                  = false
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  lambda_config {
    pre_token_generation_config {
      lambda_arn     = aws_lambda_function.pre_token.arn
      lambda_version = "V2_0"
    }
    define_auth_challenge          = aws_lambda_function.sso["define"].arn
    create_auth_challenge          = aws_lambda_function.sso["create"].arn
    verify_auth_challenge_response = aws_lambda_function.sso["verify"].arn
  }

  lifecycle { prevent_destroy = true }
}

resource "aws_cognito_user_pool_domain" "main" {
  domain                = local.auth_domain
  user_pool_id          = aws_cognito_user_pool.family.id
  certificate_arn       = aws_acm_certificate_validation.main.certificate_arn
  managed_login_version = 2
  # Cognito refuses a custom domain whose parent doesn't resolve yet.
  depends_on = [module.site]
}

resource "aws_route53_record" "auth" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.auth_domain
  type    = "A"
  alias {
    name                   = aws_cognito_user_pool_domain.main.cloudfront_distribution
    zone_id                = aws_cognito_user_pool_domain.main.cloudfront_distribution_zone_id
    evaluate_target_health = false
  }
}

# App roots (apps/*) look these up here instead of reading core's state.
resource "aws_ssm_parameter" "user_pool_id" {
  name  = "/family/core/user-pool-id"
  type  = "String"
  value = aws_cognito_user_pool.family.id
}

resource "aws_ssm_parameter" "certificate_arn" {
  name  = "/family/core/certificate-arn"
  type  = "String"
  value = aws_acm_certificate_validation.main.certificate_arn
}

resource "aws_ssm_parameter" "auth_domain" {
  name  = "/family/core/auth-domain"
  type  = "String"
  value = local.auth_domain
}

# --- Sign-in gate: enforces per-app access rules (see lambda/pre-token.mjs) ---

data "archive_file" "pre_token" {
  type        = "zip"
  source_file = "${path.module}/lambda/pre-token.mjs"
  output_path = "${path.module}/.build/pre-token.zip"
}

resource "aws_iam_role" "pre_token" {
  name = "family-pre-token"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "pre_token_logs" {
  role       = aws_iam_role.pre_token.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_iam_role_policy" "pre_token_rules" {
  role = aws_iam_role.pre_token.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "ssm:GetParameter"
      Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/family/apps/*"
    }]
  })
}

resource "aws_lambda_function" "pre_token" {
  function_name    = "family-pre-token"
  role             = aws_iam_role.pre_token.arn
  runtime          = "nodejs22.x"
  handler          = "pre-token.handler"
  filename         = data.archive_file.pre_token.output_path
  source_code_hash = data.archive_file.pre_token.output_base64sha256
  timeout          = 5
}

resource "aws_cloudwatch_log_group" "pre_token" {
  name              = "/aws/lambda/${aws_lambda_function.pre_token.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "cognito" {
  statement_id  = "AllowCognito"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.pre_token.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.family.arn
}

# The home page is itself a family app, open to every family member. As the
# portal it sees all of a user's groups, to decide which tool tiles to show.
module "home" {
  source             = "../modules/family-app"
  name               = "home"
  user_pool_id       = aws_cognito_user_pool.family.id
  callback_urls      = [local.home_url, "${local.home_url}handoff", "http://localhost:5173/"]
  open_to_all_family = true
  portal             = true
  depends_on         = [aws_cognito_user_pool_domain.main]
}

resource "aws_ssm_parameter" "home_client_id" {
  name  = "/family/core/home-client-id"
  type  = "String"
  value = module.home.client_id
}

# --- Single sign-on: tools get their own tokens from your dot-y.co sign-in ---
# Custom-auth triggers (lambda/sso-auth.mjs). A tool's one challenge is answered with a valid
# dot-y.co access token for the same person; the pre-token gate above still checks the group.

data "archive_file" "sso" {
  type        = "zip"
  output_path = "${path.module}/.build/sso-auth.zip"
  source {
    filename = "sso-auth.mjs"
    content  = file("${path.module}/lambda/sso-auth.mjs")
  }
  source {
    filename = "verify-token.mjs"
    content  = file("${path.module}/lambda/verify-token.mjs") # symlink to platform/api
  }
}

resource "aws_iam_role" "sso" {
  name               = "family-sso-auth"
  assume_role_policy = aws_iam_role.pre_token.assume_role_policy
}

resource "aws_iam_role_policy_attachment" "sso_logs" {
  role       = aws_iam_role.sso.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "sso_home_client" {
  role = aws_iam_role.sso.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = "ssm:GetParameter"
      # Built by name: the pool needs these Lambdas before the home client exists.
      Resource = "arn:aws:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter/family/core/home-client-id"
    }]
  })
}

resource "aws_lambda_function" "sso" {
  for_each         = toset(["define", "create", "verify"])
  function_name    = "family-sso-${each.key}"
  role             = aws_iam_role.sso.arn
  runtime          = "nodejs22.x"
  handler          = "sso-auth.${each.key}"
  filename         = data.archive_file.sso.output_path
  source_code_hash = data.archive_file.sso.output_base64sha256
  timeout          = 5
  environment {
    variables = { HOME_CLIENT_PARAM = "/family/core/home-client-id" }
  }
}

resource "aws_cloudwatch_log_group" "sso" {
  for_each          = aws_lambda_function.sso
  name              = "/aws/lambda/${each.value.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_permission" "sso" {
  for_each      = aws_lambda_function.sso
  statement_id  = "AllowCognito"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.family.arn
}
