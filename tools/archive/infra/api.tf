locals {
  routes = [
    "GET /dot", "GET /drawers", "PUT /drawers/{id}", "GET /files", "GET /files/{id}", "GET /files/{id}/text", "GET /files/{id}/download",
    "POST /uploads", "PATCH /files/{id}", "PUT /files/{id}/links/{to}", "DELETE /files/{id}/links/{to}",
    "DELETE /files/{id}", "GET /share-options", "POST /batches", "GET /batches/{id}", "POST /sort", "GET /sort/{id}",
  ]
}

# The handler with the platform's token check, sharing rules, family groups and manifest, bundled with
# the S3 presigner by `npm run build`
data "archive_file" "api" {
  type        = "zip"
  output_path = "${path.module}/.build/api.zip"
  source {
    content  = file("${path.module}/../api/dist/api.mjs")
    filename = "api.mjs"
  }
}

# The family's groups (platform/family): read only, for sharing a drawer with a group
data "aws_ssm_parameter" "people_table_arn" {
  name = "/family/people/table-arn"
}

data "aws_caller_identity" "current" {}

resource "aws_iam_role" "api" {
  name = "family-archive-api"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Its table and the family's groups; who is in family_archive (to share with); the files to sign uploads
# into f/ and downloads from it, to read what intake wrote, and to delete a file for good (page, owner,
# from the trash only; versioning keeps it 30 more days).
resource "aws_iam_role_policy" "api_table" {
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query"], Resource = aws_dynamodb_table.main.arn },
      { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = nonsensitive(data.aws_ssm_parameter.people_table_arn.value) },
      { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.files.arn}/f/*" },
      { Effect = "Allow", Action = ["s3:GetObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.files.arn}/text/*" },
      # A sort: start Molly on it (molly.tf); nothing else may invoke her but the mail gate
      { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.molly.arn },
      # Bulk uploads: become the uploader role, narrowed to one batch's prefix (bulk.tf)
      { Effect = "Allow", Action = "sts:AssumeRole", Resource = aws_iam_role.uploader.arn },
      { Effect = "Allow", Action = "cognito-idp:ListUsersInGroup", Resource = "arn:aws:cognito-idp:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:userpool/${local.pool_id}" },
      { Effect = "Allow", Action = ["kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.files.arn },
    ]
  })
}

resource "aws_lambda_function" "api" {
  function_name    = "family-archive-api"
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "api.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  timeout          = 29 # search reads every drawer it may; API Gateway waits 29s
  memory_size      = 512

  environment {
    variables = {
      TABLE               = aws_dynamodb_table.main.name
      GROUP               = module.app.member_group
      ISSUER              = local.issuer
      CLIENT_ID           = module.app.client_id
      DELEGATED_CLIENT_ID = module.app.delegated_client_id
      PEOPLE_TABLE        = element(split("/", nonsensitive(data.aws_ssm_parameter.people_table_arn.value)), 1)
      BUCKET              = aws_s3_bucket.files.id
      USER_POOL_ID        = local.pool_id
      UPLOADER_ROLE       = aws_iam_role.uploader.arn
      FILES_KEY           = aws_kms_key.files.arn
      MOLLY_WORKER        = aws_lambda_function.molly.arn
    }
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 30
}

resource "aws_apigatewayv2_api" "api" {
  name          = "family-archive"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = [trimsuffix(local.app_url, "/"), trimsuffix(local.dev_url, "/")]
    allow_methods = ["GET", "PUT", "POST", "PATCH", "DELETE"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 600
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.api.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = local.issuer
    audience = [module.app.client_id, module.app.delegated_client_id]
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api" {
  for_each           = toset(local.routes)
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowToolApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

# Where Dot and Claude Code (platform/mcp) find this tool
resource "aws_ssm_parameter" "delegation" {
  name        = "/family/delegation/${local.name}"
  description = "Archive API and delegated client, for Claude Code"
  type        = "String"
  value = jsonencode({
    api_url   = aws_apigatewayv2_api.api.api_endpoint
    client_id = module.app.delegated_client_id
  })
}
