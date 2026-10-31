# Otto at otto.dot-y.co, for members of lukes_otto (Luke only): Luke's agent on the home server.
# The agent (agent/, Proxmox CT 103) holds no AWS credentials: it calls this tool's agent API with its
# key (agent.tf), and this tool's roles do the AWS work. People stage work on the page, through Dot, or
# from Claude Code (platform/mcp); a staged command from Dot or Claude Code needs the person's own OK.

variable "domain_name" {
  type    = string
  default = "dot-y.co"
}

# The one person Otto works for and emails (Cognito usernames are subs)
variable "owner" {
  type    = string
  default = "44f8c468-4011-70b8-76aa-ec2b68b0b004" # Luke
}

locals {
  name         = "lukes_otto"
  host         = "otto.${var.domain_name}"
  app_url      = "https://${local.host}/"
  dev_url      = "http://localhost:5173/"
  pool_id      = data.aws_ssm_parameter.user_pool_id.value
  issuer       = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${local.pool_id}"
  otto_address = "otto@${var.domain_name}"
  time_zone    = "America/New_York"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

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
  delegated     = true           # Dot stages work and schedules for the person asking, via its GET /dot manifest
  delegates     = ["dot", "mcp"] # and Claude Code (platform/mcp), as the person; either way they OK it first
  tile = {
    title       = "Otto"
    description = "Your agent at home: inbox work, a daily brief, and what it did."
    url         = local.app_url
    icon        = "chat"
  }
}
