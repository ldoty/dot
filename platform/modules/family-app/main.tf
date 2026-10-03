# Registers one project with the shared family login:
#  - its own app client (tokens carry aud = this client, so other apps' APIs reject them)
#  - groups "<name>" (members) and "<name>:admin"
#  - an access rule at /family/apps/<clientId> that the pre-token Lambda enforces at sign-in,
#    plus the URLs dot-y.co/handoff may return single sign-on tokens to
#  - optionally a tile on the dot-y.co home page, shown only to members (/family/catalog/<name>)

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" {
  type        = string
  description = "Short app name: group names, the `app` token claim, and the client name."
  validation {
    condition     = can(regex("^[a-z][a-z0-9_-]*$", var.name))
    error_message = "name must be lowercase letters, digits, - or _."
  }
}

variable "user_pool_id" {
  type = string
}

variable "callback_urls" {
  type        = list(string)
  description = "URLs Cognito may redirect back to after sign-in and sign-out."
}

variable "open_to_all_family" {
  type        = bool
  default     = false
  description = "true = any family member may sign in; false = only members of the <name> group."
}

variable "portal" {
  type        = bool
  default     = false
  description = "true = tokens carry all of the user's groups (only the home page needs this)."
}

variable "tile" {
  type = object({
    title       = string
    description = string
    url         = string
    icon        = optional(string) # leaf (default), coins, links, chat, mushroom: see core/portal/index.html
  })
  default     = null
  description = "Home page tile, shown to members of this app. Re-apply core to pick up changes."
}

resource "aws_cognito_user_group" "member" {
  user_pool_id = var.user_pool_id
  name         = var.name
  description  = "Can use ${var.name}"
}

resource "aws_cognito_user_group" "admin" {
  user_pool_id = var.user_pool_id
  name         = "${var.name}:admin"
  description  = "Admin of ${var.name}"
}

resource "aws_cognito_user_pool_client" "this" {
  name                                 = var.name
  user_pool_id                         = var.user_pool_id
  generate_secret                      = false
  # Tools also allow CUSTOM_AUTH: single sign-on from dot-y.co (see core/lambda/sso-auth.mjs).
  explicit_auth_flows                  = concat(["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], var.portal ? [] : ["ALLOW_CUSTOM_AUTH"])
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.callback_urls
  logout_urls                          = var.callback_urls
  prevent_user_existence_errors        = "ENABLED"

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}

# Managed login v2 needs a branding style per client.
resource "aws_cognito_managed_login_branding" "this" {
  user_pool_id                = var.user_pool_id
  client_id                   = aws_cognito_user_pool_client.this.id
  use_cognito_provided_values = true
}

resource "aws_ssm_parameter" "access_rule" {
  name        = "/family/apps/${aws_cognito_user_pool_client.this.id}"
  description = "Sign-in rule for family app ${var.name}"
  type        = "String"
  value = jsonencode({
    app    = var.name
    group  = var.open_to_all_family ? "*" : var.name
    portal = var.portal
    # Where dot-y.co/handoff may send this app's tokens (https only, never the portal itself)
    returns = var.portal ? [] : [for u in var.callback_urls : u if startswith(u, "https://")]
  })
}

resource "aws_ssm_parameter" "tile" {
  count       = var.tile == null ? 0 : 1
  name        = "/family/catalog/${var.name}"
  description = "Home page tile for family app ${var.name}"
  type        = "String"
  value       = jsonencode(merge(var.tile, { group = var.open_to_all_family ? "*" : var.name }))
}

output "client_id" { value = aws_cognito_user_pool_client.this.id }
output "member_group" { value = aws_cognito_user_group.member.name }
output "admin_group" { value = aws_cognito_user_group.admin.name }
