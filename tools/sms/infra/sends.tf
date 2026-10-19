# The daily limit on everything Dot-y sends someone unasked (platform/api/send-limit.mjs): one small
# row per person per day, counted by each sender before it sends (House's automation texts, Lists'
# reminders, Dot's scheduled asks), so together they never pass 50. Each sender's role may only get
# and put here; the rows expire on their own.
resource "aws_dynamodb_table" "sends" {
  name                        = "dot-y-sends"
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
  lifecycle { prevent_destroy = true }
}

# Read by tools/house, tools/lists and tools/assistant (apply this root first)
resource "aws_ssm_parameter" "sends_table_arn" {
  name  = "/family/sms/sends-table-arn"
  type  = "String"
  value = aws_dynamodb_table.sends.arn
}
