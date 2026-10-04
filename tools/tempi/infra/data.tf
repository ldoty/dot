# Single table: pk = USER#<sub>, sk = PROGRESS (one saved course state per user).
resource "aws_dynamodb_table" "main" {
  name                        = "family-tempi"
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
