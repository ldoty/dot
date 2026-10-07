# Two Boards at boards.dot-y.co: Luke’s field guide to the NextGEN and Artisphere boards, for members of lukes_boards.

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

locals {
  name    = "lukes_boards"
  host    = "boards.${var.domain_name}"
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
    title       = "Two Boards"
    description = "Who’s on the two boards, where they overlap, the plan, and flashcards."
    url         = local.app_url
    icon        = "venn" # see the icon list in platform/core/portal/index.html
  }
}
