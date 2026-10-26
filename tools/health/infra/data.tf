# Single table: pk = P#<username> (each person's own), sk = SETTINGS | PLAN | EX#<id> | WO#<id> | S#<id> | BW#<date> | J#<date> | F#<id> | M#<id> | T#<date>#<dose id>.
resource "aws_dynamodb_table" "main" {
  name                        = "family-health"
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
