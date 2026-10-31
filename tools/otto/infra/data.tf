# Single table; the rows are listed in api/store.mjs and the README.
resource "aws_dynamodb_table" "main" {
  name                        = "family-otto"
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

  # Commands, confirmations, mail and sent emails carry `expires` (epoch seconds)
  ttl {
    attribute_name = "expires"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle { prevent_destroy = true }
}
