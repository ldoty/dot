output "url" { value = local.app_url }
output "api_url" { value = aws_apigatewayv2_api.api.api_endpoint }
output "client_id" { value = module.app.client_id }
output "table" { value = aws_dynamodb_table.main.name }
output "mail_address" { value = local.mail_address }
