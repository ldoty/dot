# Single table: pk = TOOL, sk = TRIP#<id> (a whole trip per row: details, notes, itinerary, packing list; rev-checked).
resource "aws_dynamodb_table" "main" {
  name                        = "family-trip-planner"
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
