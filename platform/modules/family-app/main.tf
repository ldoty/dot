# Registers one project with the shared family login:
#  - its own app client (tokens carry aud = this client, so other apps' APIs reject them)
#  - groups "<name>" (members) and "<name>:admin"
#  - an access rule at /family/apps/<clientId> that the pre-token Lambda enforces at sign-in,
#    plus the URLs dot-y.co/handoff may return single sign-on tokens to
#  - optionally a tile on the dot-y.co home page, shown only to members (/family/catalog/<name>)
#  - optionally a delegated client: how Dot gets this app's tokens for the person asking it
#    (read-only, same group rule; see platform/api/delegation.mjs)
#  - optionally an MCP client: how Claude Code signs in to the app's remote MCP server (POST /mcp)
#    as the person, through the same sign-in page and the same group rule

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

variable "delegated" {
  type        = bool
  default     = false
  description = "true = Dot may use this app on behalf of whoever asks it (read-only, members only)."
}

variable "delegates" {
  type        = list(string)
  default     = ["dot"]
  description = "Signers whose assertions this app's delegated client accepts (core's delegation_signers, plus dot)."
}

variable "mcp_callback_urls" {
  type        = list(string)
  default     = []
  description = "Non-empty = an MCP client for Claude Code (public, code + PKCE) returning to these localhost URLs."
  validation {
    condition     = alltrue([for u in var.mcp_callback_urls : can(regex("^http://localhost:[0-9]+/callback$", u))])
    error_message = "MCP callbacks are http://localhost:<port>/callback: Claude Code listens there during sign-in."
  }
}

variable "tile" {
  type = object({
    title       = string
    description = string
    url         = string
    icon        = optional(string) # leaf (default), coins, links, chat, mushroom, house, checklist, calendar, cabinet: see core/portal/index.html
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

# Dot's client: custom auth only (Dot's signed assertion), no sign-in page, short-lived tokens.
# Refresh tokens can't be turned off; Dot never keeps them.
resource "aws_cognito_user_pool_client" "delegated" {
  count                         = var.delegated ? 1 : 0
  name                          = "${var.name}-via-dot"
  user_pool_id                  = var.user_pool_id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_CUSTOM_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"

  access_token_validity  = 5
  id_token_validity      = 5
  refresh_token_validity = 60
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "minutes"
  }
}

resource "aws_ssm_parameter" "delegated_rule" {
  count       = var.delegated ? 1 : 0
  name        = "/family/apps/${aws_cognito_user_pool_client.delegated[0].id}"
  description = "Sign-in rule for Dot acting in family app ${var.name}"
  type        = "String"
  value = jsonencode({
    app       = var.name
    group     = var.open_to_all_family ? "*" : var.name
    delegated = true
    delegates = var.delegates
  })
}

# Claude Code's client for the app's MCP server: sign-in page (code + PKCE, no secret: it runs on a
# laptop), back to Claude Code on localhost. No CUSTOM_AUTH, so /handoff can't mint its tokens. Same
# group rule as the app; tokens are for this client only, so the app's web routes refuse them.
resource "aws_cognito_user_pool_client" "mcp" {
  count                                = length(var.mcp_callback_urls) > 0 ? 1 : 0
  name                                 = "${var.name}-mcp"
  user_pool_id                         = var.user_pool_id
  generate_secret                      = false
  explicit_auth_flows                  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.mcp_callback_urls
  logout_urls                          = var.mcp_callback_urls
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

resource "aws_cognito_managed_login_branding" "mcp" {
  count                       = length(var.mcp_callback_urls) > 0 ? 1 : 0
  user_pool_id                = var.user_pool_id
  client_id                   = aws_cognito_user_pool_client.mcp[0].id
  use_cognito_provided_values = true
}

resource "aws_ssm_parameter" "mcp_rule" {
  count       = length(var.mcp_callback_urls) > 0 ? 1 : 0
  name        = "/family/apps/${aws_cognito_user_pool_client.mcp[0].id}"
  description = "Sign-in rule for Claude Code in family app ${var.name}"
  type        = "String"
  value = jsonencode({
    app     = var.name
    group   = var.open_to_all_family ? "*" : var.name
    portal  = false
    returns = [] # never a /handoff destination
  })
}

output "client_id" { value = aws_cognito_user_pool_client.this.id }
output "delegated_client_id" { value = var.delegated ? aws_cognito_user_pool_client.delegated[0].id : null }
output "mcp_client_id" { value = length(var.mcp_callback_urls) > 0 ? aws_cognito_user_pool_client.mcp[0].id : null }
output "member_group" { value = aws_cognito_user_group.member.name }
output "admin_group" { value = aws_cognito_user_group.admin.name }
