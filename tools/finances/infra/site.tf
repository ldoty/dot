module "site" {
  source          = "../../../platform/modules/static-site"
  name            = local.prefix
  domain_name     = local.host
  zone_id         = data.aws_route53_zone.main.zone_id
  certificate_arn = data.aws_ssm_parameter.certificate_arn.value
}

locals {
  site_files = {
    "index.html"     = "${path.module}/../web/index.html"
    "family-auth.js" = "${path.module}/../../../platform/web/family-auth.js"
    "family.css"     = "${path.module}/../../../platform/web/family.css"
    "favicon.svg"    = "${path.module}/../../../platform/web/favicon.svg"
  }
  content_types = { html = "text/html; charset=utf-8", js = "text/javascript", css = "text/css", svg = "image/svg+xml" }
}

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
    authDomain  = data.aws_ssm_parameter.auth_domain.value
    clientId    = module.app.client_id
    redirectUri = local.app_url
    apiUrl      = aws_apigatewayv2_api.api.api_endpoint
    title       = var.title
    tool        = var.tool
    mode        = var.mode # the page shows the household (shared) or a person's budget
  })
}
