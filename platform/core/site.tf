# Home page at the apex. Also satisfies Cognito's rule that a custom
# domain's parent (dot-y.co for auth.dot-y.co) must resolve.

locals {
  home_url = "https://${var.domain_name}/"
  # path on the site => local file. Shared house style and sign-in live here for every tool.
  site_files = {
    "index.html"             = "${path.module}/portal/index.html"
    "family-auth.js"         = "${path.module}/../web/family-auth.js"
    "style/family.css"       = "${path.module}/../web/family.css"
    "style/favicon.svg"      = "${path.module}/../web/favicon.svg"
    "style/style-guide.html" = "${path.module}/../web/style-guide.html"
  }
  content_types = { html = "text/html; charset=utf-8", js = "text/javascript", css = "text/css", svg = "image/svg+xml" }
}

module "site" {
  source          = "../modules/static-site"
  name            = "family-home"
  domain_name     = var.domain_name
  zone_id         = data.aws_route53_zone.main.zone_id
  certificate_arn = aws_acm_certificate_validation.main.certificate_arn
}

# Short max-age instead of invalidations; these are tiny files.
resource "aws_s3_object" "site" {
  for_each      = local.site_files
  bucket        = module.site.bucket
  key           = each.key
  source        = each.value
  etag          = filemd5(each.value)
  content_type  = local.content_types[regex("[^.]+$", each.key)]
  cache_control = "max-age=60"
}

resource "aws_s3_object" "config" {
  bucket        = module.site.bucket
  key           = "config.json"
  content_type  = "application/json"
  cache_control = "max-age=60"
  content = jsonencode({
    authDomain  = aws_cognito_user_pool_domain.main.domain
    clientId    = module.home.client_id
    redirectUri = local.home_url
    region      = data.aws_region.current.region
  })
}

# Pages served at extensionless paths: dot-y.co/handoff (single sign-on for tools), and
# /sms, /privacy, /terms: the SMS program's opt-in page and its policies, which carrier
# reviewers visit. The form posts to tools/sms.
resource "aws_s3_object" "page" {
  for_each      = toset(["handoff", "sms", "privacy", "terms"])
  bucket        = module.site.bucket
  key           = each.key
  source        = "${path.module}/portal/${each.key}.html"
  etag          = filemd5("${path.module}/portal/${each.key}.html")
  content_type  = "text/html; charset=utf-8"
  cache_control = "max-age=60"
}

data "aws_ssm_parameter" "sms_optin_url" {
  name = "/family/sms/optin-url"
}

resource "aws_s3_object" "sms_config" {
  bucket        = module.site.bucket
  key           = "sms-config.json"
  content_type  = "application/json"
  cache_control = "max-age=60"
  content       = jsonencode({ optinUrl = nonsensitive(data.aws_ssm_parameter.sms_optin_url.value) })
}

# Tool tiles registered by app roots (modules/family-app `tile`). The page shows
# each person only the tiles for groups they're in. Re-apply core after adding an app.
data "aws_ssm_parameters_by_path" "catalog" {
  path = "/family/catalog/"
}

resource "aws_s3_object" "catalog" {
  bucket        = module.site.bucket
  key           = "apps.json"
  content_type  = "application/json"
  cache_control = "max-age=60"
  content       = jsonencode([for v in nonsensitive(data.aws_ssm_parameters_by_path.catalog.values) : jsondecode(v)])
}

# Single sign-on: which URLs dot-y.co/handoff may send each app's tokens to, from the
# apps' access rules. Re-apply core after adding an app (same as apps.json).
data "aws_ssm_parameters_by_path" "apps" {
  path = "/family/apps/"
}

resource "aws_s3_object" "sso" {
  bucket        = module.site.bucket
  key           = "sso.json"
  content_type  = "application/json"
  cache_control = "max-age=60"
  content = jsonencode({
    for i, name in data.aws_ssm_parameters_by_path.apps.names :
    trimprefix(name, "/family/apps/") => {
      app     = jsondecode(nonsensitive(data.aws_ssm_parameters_by_path.apps.values[i])).app
      returns = try(jsondecode(nonsensitive(data.aws_ssm_parameters_by_path.apps.values[i])).returns, [])
    }
    if length(try(jsondecode(nonsensitive(data.aws_ssm_parameters_by_path.apps.values[i])).returns, [])) > 0
  })
}

# --- Moved into modules/static-site (2026-10-02) ---
moved {
  from = aws_s3_bucket.site
  to   = module.site.aws_s3_bucket.this
}
moved {
  from = aws_s3_bucket_public_access_block.site
  to   = module.site.aws_s3_bucket_public_access_block.this
}
moved {
  from = aws_cloudfront_origin_access_control.site
  to   = module.site.aws_cloudfront_origin_access_control.this
}
moved {
  from = aws_cloudfront_distribution.site
  to   = module.site.aws_cloudfront_distribution.this
}
moved {
  from = aws_s3_bucket_policy.site
  to   = module.site.aws_s3_bucket_policy.this
}
moved {
  from = aws_route53_record.apex
  to   = module.site.aws_route53_record.alias
}
moved {
  from = aws_s3_object.index
  to   = aws_s3_object.site["index.html"]
}
