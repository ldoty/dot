output "url" { value = local.app_url }
output "api_url" { value = aws_lambda_function_url.api.function_url }
output "client_id" { value = module.app.client_id }
output "table" { value = aws_dynamodb_table.main.name }
