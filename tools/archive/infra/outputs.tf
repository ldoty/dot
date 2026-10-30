output "url" { value = local.app_url }
output "api_url" { value = aws_apigatewayv2_api.api.api_endpoint }
output "client_id" { value = module.app.client_id }
output "table" { value = aws_dynamodb_table.main.name }
output "mcp_url" { value = "${aws_apigatewayv2_api.api.api_endpoint}/mcp" }
output "mcp_client_id" { value = module.app.mcp_client_id }
# Run once to add the archive to Claude Code (any folder), then /mcp to sign in. Its values come
# partly from SSM (so marked sensitive) but none is secret.
output "claude_mcp_add" {
  value = nonsensitive("claude mcp add-json --scope user archive '${jsonencode({
    type = "http"
    url  = "${aws_apigatewayv2_api.api.api_endpoint}/mcp"
    oauth = {
      clientId              = module.app.mcp_client_id
      callbackPort          = local.mcp_callback_port
      scopes                = "openid email profile"
      authServerMetadataUrl = "${aws_apigatewayv2_api.api.api_endpoint}/.well-known/oauth-authorization-server"
    }
  })}'")
}
