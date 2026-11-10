# Trip planner at trip-planner.dot-y.co, for members of lukes_trip_planner.

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

locals {
  name    = "lukes_trip_planner"
  host    = "trip-planner.${var.domain_name}"
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
    title       = "Trip planner"
    description = "Trips on a calendar, each with notes, an itinerary and a packing list."
    url         = local.app_url
    icon        = "backpack"
  }
}
