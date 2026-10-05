# One finances tool, deployed once per person (tools/luke-finances, tools/amber-finances) and once
# for the household (tools/shared-finances, mode = "shared"). Each deployment is its own root with
# its own state; this module is everything it creates.
#
# Personal: the person's bank and card transactions from their own SimpleFIN Bridge connection,
# filed under the lines of their budget (read from Budget as them, read-only), month to date.
# Shared: the accounts marked shared in the personal tools, read from them as their owners
# (read-only) and de-duplicated, filed under the Shared budget.

variable "tool" {
  type        = string
  description = "Deployment name: the host (<tool>.dot-y.co) and AWS names (family-<tool>-…)"
}

variable "group" {
  type        = string
  description = "Permission group, also this tool's signer name in core's delegation_signers"
}

variable "title" {
  type = string
}

variable "tile_description" {
  type = string
}

variable "person" {
  type        = string
  default     = "shared"
  description = "Whose budget doc (Budget's doc name: Luke, Amber), or shared for the household"
}

variable "owner" {
  type        = object({ sub = string, username = string })
  default     = null
  description = "Personal: whose budget the nightly sync reads (core's delegation_signers must allow this sub)"
}

variable "partition" {
  type        = string
  description = "The table's partition key value (LUKE for Luke's existing data)"
}

variable "model" {
  type        = string
  default     = "us.anthropic.claude-opus-4-6-v1"
  description = "Claude on Bedrock for filing transactions; the model Dot uses (Opus 4.7+ needs AWS approval first)."
}

variable "delegates" {
  type        = list(string)
  default     = ["dot", "shared_finances"]
  description = "Who may read this tool as its members: Dot, and (personal tools) Shared Finances, for the shared accounts"
}

variable "mode" {
  type        = string
  default     = "personal"
  description = "personal: one person's SimpleFIN accounts and budget. shared: the household's shared accounts, read from the personal tools"
  validation {
    condition     = contains(["personal", "shared"], var.mode)
    error_message = "mode is personal or shared."
  }
}

variable "sources" {
  type        = list(object({ app = string, name = string, sub = string, username = string }))
  default     = []
  description = "Shared: the personal tools to read shared accounts from, each as its owner (core lets shared_finances act for them)"
}

variable "schedule" {
  type        = string
  default     = "cron(30 6 * * ? *)"
  description = "Nightly sync, New York time. Shared runs after the personal tools have synced."
}

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

locals {
  name    = var.group
  prefix  = "family-${var.tool}"
  host    = "${var.tool}.${var.domain_name}"
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
  delegated     = true # Dot reads it for its members (read-only), via its GET /dot manifest
  delegates     = var.delegates
  tile = {
    title       = var.title
    description = var.tile_description
    url         = local.app_url
    icon        = "coins" # see the icon list in platform/core/portal/index.html
  }
}
