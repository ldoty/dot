# Single table. pk = BUSINESS#<id>; sk = DOC#<doc>#STATE | DOC#<doc>#VERSION#<id> | TAG#<doc>#<name>.
# This is the only copy of the budget, so it's protected against deletion and backed up continuously.
resource "aws_dynamodb_table" "budget" {
  name                        = "family-sdc-sce-budget"
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
