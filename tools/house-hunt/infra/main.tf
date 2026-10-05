# House Hunt at house-hunt.dot-y.co, for members of family_house_hunt.

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

locals {
  name    = "family_house_hunt"
  host    = "house-hunt.${var.domain_name}"
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
    title       = "House Hunt"
    description = "Greer neighborhoods we're weighing, with prices and our notes."
    url         = local.app_url
    icon        = "house" # see the icon list in platform/core/portal/index.html
  }
}
