# Cheer Research at cheer-research.dot-y.co: Luke’s field guide to the youth cheer and dance market, for members of lukes_research.

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

locals {
  name    = "lukes_research"
  host    = "cheer-research.${var.domain_name}"
  app_url = "https://${local.host}/"
  dev_url = "http://localhost:5173/"
  pool_id = data.aws_ssm_parameter.user_pool_id.value
  issuer  = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${local.pool_id}"
}

data "aws_region" "current" {}

data "aws_ssm_parameter" "user_pool_id" {
  name = "/family/core/user-pool-id"
}

data "aws_ssm_parameter" "certificate_arn" {
  name = "/family/core/certificate-arn"
}

data "aws_ssm_parameter" "auth_domain" {
  name = "/family/core/auth-domain"
}

data "aws_route53_zone" "main" {
  name = var.domain_name
}

module "app" {
  source        = "../../../platform/modules/family-app"
  name          = local.name
  user_pool_id  = local.pool_id
  callback_urls = [local.app_url, local.dev_url]
  tile = {
    title       = "Cheer Research"
    description = "The cheer and dance market: players, money flows, a calculator, and flashcards."
    url         = local.app_url
    icon        = "climb" # see the icon list in platform/core/portal/index.html
  }
}
