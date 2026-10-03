# Conversations: pk = USER#<sub>, sk = CONV#<id> | MSG#<id>#<seq> (see api/store.mjs)
resource "aws_dynamodb_table" "main" {
  name                        = "lukes-assistant"
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
