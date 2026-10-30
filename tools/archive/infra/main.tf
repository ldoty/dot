# Archive at archive.dot-y.co, for members of family_archive: the family's documents, kept by
# Molly (email: molly@dot-y.co). Claude Code reaches it through platform/mcp, like any tool.

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

locals {
  name    = "family_archive"
  host    = "archive.${var.domain_name}"
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
  delegated     = true    # used as the person through its GET /dot manifest:
  delegates     = ["mcp"] # Claude Code (platform/mcp) for now; Dot when it's ready for it
  tile = {
    title       = "Archive"
    description = "The family’s documents, filed by Molly."
    url         = local.app_url
    icon        = "cabinet"
  }
}
