# Luke & Amber's household budget at budget.dot-y.co.
#
# Access is checked at four layers:
#  1. Cognito: the pre-token gate issues no token for this app unless the user is in family_budget.
#  2. API Gateway: the JWT authorizer only accepts pool tokens issued to this app's client.
#  3. Lambda: re-verifies the token itself (signature, issuer, client, expiry, family_budget group).
#  4. IAM: the Lambda can touch only this table, and only this API can invoke it.
#
# The page itself holds no data; every number lives in DynamoDB behind the API.

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

variable "household" {
  type        = string
  default     = "luke-amber"
  description = "Partition key for this household's records."
}

locals {
  name    = "family_budget"
  host    = "budget.${var.domain_name}"
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
  delegated     = true                                                          # Dot can read the budget for members who ask it
  delegates     = ["dot", "luke_finances", "amber_finances", "shared_finances"] # and the finances tools, as their person
  tile = {
    title       = "Budget"
    description = "Luke & Amber’s household budget: shared costs, the mortgage and each person’s plan."
    url         = local.app_url
    icon        = "coins"
  }
}
