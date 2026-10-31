output "url" { value = local.app_url }
output "api_url" { value = aws_apigatewayv2_api.api.api_endpoint }
output "agent_api_url" { value = aws_apigatewayv2_api.api.api_endpoint } # the agent's routes are /agent/* on the same API
output "client_id" { value = module.app.client_id }
output "table" { value = aws_dynamodb_table.main.name }
output "otto_address" { value = local.otto_address }
