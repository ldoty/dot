# Luke’s Finances at luke-finances.dot-y.co, for members of luke_finances: the finances tool
# (tools/finances) deployed for Luke.

module "finances" {
  source           = "../../finances/infra"
  tool             = "luke-finances"
  group            = "luke_finances"
  title            = "Luke’s Finances"
  tile_description = "Luke’s accounts, filed under his budget: how each line is tracking this month."
  person           = "Luke"
  partition        = "LUKE"
  owner = {
    sub      = "44f8c468-4011-70b8-76aa-ec2b68b0b004"
    username = "44f8c468-4011-70b8-76aa-ec2b68b0b004"
  }
}

output "url" { value = module.finances.url }
output "api_url" { value = module.finances.api_url }

# This deployment's resources were made before the module existed; these keep them in place
moved {
  from = aws_apigatewayv2_api.api
  to   = module.finances.aws_apigatewayv2_api.api
}
moved {
  from = aws_apigatewayv2_authorizer.cognito
  to   = module.finances.aws_apigatewayv2_authorizer.cognito
}
moved {
  from = aws_apigatewayv2_integration.api
  to   = module.finances.aws_apigatewayv2_integration.api
}
moved {
  from = aws_apigatewayv2_route.api
  to   = module.finances.aws_apigatewayv2_route.api
}
moved {
  from = aws_apigatewayv2_stage.default
  to   = module.finances.aws_apigatewayv2_stage.default
}
moved {
  from = aws_cloudwatch_log_group.api
  to   = module.finances.aws_cloudwatch_log_group.api
}
moved {
  from = aws_dynamodb_table.main
  to   = module.finances.aws_dynamodb_table.main
}
moved {
  from = aws_iam_role_policy_attachment.api_logs
  to   = module.finances.aws_iam_role_policy_attachment.api_logs
}
moved {
  from = aws_iam_role_policy.api
  to   = module.finances.aws_iam_role_policy.api
}
moved {
  from = aws_iam_role_policy.scheduler
  to   = module.finances.aws_iam_role_policy.scheduler
}
moved {
  from = aws_iam_role.api
  to   = module.finances.aws_iam_role.api
}
moved {
  from = aws_iam_role.scheduler
  to   = module.finances.aws_iam_role.scheduler
}
moved {
  from = aws_lambda_function.api
  to   = module.finances.aws_lambda_function.api
}
moved {
  from = aws_lambda_function.sync
  to   = module.finances.aws_lambda_function.sync
}
moved {
  from = aws_lambda_permission.api
  to   = module.finances.aws_lambda_permission.api
}
moved {
  from = aws_s3_object.config
  to   = module.finances.aws_s3_object.config
}
moved {
  from = aws_s3_object.site
  to   = module.finances.aws_s3_object.site
}
moved {
  from = aws_scheduler_schedule.sync
  to   = module.finances.aws_scheduler_schedule.sync
}
moved {
  from = aws_ssm_parameter.delegation
  to   = module.finances.aws_ssm_parameter.delegation
}
moved {
  from = aws_ssm_parameter.simplefin
  to   = module.finances.aws_ssm_parameter.simplefin
}
moved {
  from = module.app
  to   = module.finances.module.app
}
moved {
  from = module.site
  to   = module.finances.module.site
}
