# Single table: pk = TOOL, sk = SECTION#<id> | LINK#<id>.
resource "aws_dynamodb_table" "main" {
  name                        = "family-links"
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
}
