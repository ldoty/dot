# Single table; the rows are listed in api/relay-ws.mjs (what the house reports) and
# api/grants.mjs (who may do what), and in the README.
resource "aws_dynamodb_table" "main" {
  name                        = "family-house"
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

  # Audit rows, confirmations and command results carry `expires` (epoch seconds)
  ttl {
    attribute_name = "expires"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle { prevent_destroy = true }
}
