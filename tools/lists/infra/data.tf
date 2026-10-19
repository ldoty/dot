# Single table; the rows are listed in api/api.mjs and api/sweep.mjs, and in the README.
# Sent reminders and pending confirmations carry `expires` (epoch seconds).
resource "aws_dynamodb_table" "main" {
  name                        = "family-lists"
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

  ttl {
    attribute_name = "expires"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  lifecycle { prevent_destroy = true }
}
