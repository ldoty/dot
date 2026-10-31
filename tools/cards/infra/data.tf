# Single table; the rows are listed in api/api.mjs and the README.
resource "aws_dynamodb_table" "main" {
  name                        = "family-cards"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle { prevent_destroy = true }
}
