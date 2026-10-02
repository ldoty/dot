output "home_url" { value = local.home_url }
output "auth_url" { value = "https://${local.auth_domain}" }
output "user_pool_id" { value = aws_cognito_user_pool.family.id }
output "home_client_id" { value = module.home.client_id }
