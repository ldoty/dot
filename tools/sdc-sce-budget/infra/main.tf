# SDC/SCE's business budget at sdc-sce-budget.dot-y.co, for members of sdc_sce_budget (Luke and Amber).
#
# Access is checked at four layers:
#  1. Cognito: the pre-token gate issues no token for this app unless the user is in sdc_sce_budget.
#  2. API Gateway: the JWT authorizer only accepts pool tokens issued to this app's clients.
#  3. Lambda: re-verifies the token itself (signature, issuer, client, expiry, group).
#  4. IAM: the Lambda can touch only this table's partition, and only this API can invoke it.
#
# Only SDC/SCE Finances may read it as a person (read-only); Dot and Claude Code may not.

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

variable "business" {
  type        = string
  default     = "sdc-sce"
  description = "Partition key for this business's records."
}

locals {
  name    = "sdc_sce_budget"
  host    = "sdc-sce-budget.${var.domain_name}"
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
  delegated     = true                 # SDC/SCE Finances reads the budget as its person
  delegates     = ["sdc_sce_finances"] # and nothing else: not Dot, not Claude Code
  tile = {
    title       = "SDC/SCE Budget"
    description = "The business’s budget: income, expenses and what’s set aside, with saved versions."
    url         = local.app_url
    icon        = "coins"
  }
}
