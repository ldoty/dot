# Study progress: pk = USER#<sub>, sk = PROGRESS (the app’s whole review history as JSON, with rev)
resource "aws_dynamodb_table" "main" {
  name                        = "family-biomap"
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

# The published collection (deck.json + photos/), written by scripts/publish.sh. Private: the
# app only sees photos through short-lived signed URLs from the API.
resource "aws_s3_bucket" "collection" {
  bucket_prefix = "lukes-biomap-collection-"
}

resource "aws_s3_bucket_public_access_block" "collection" {
  bucket                  = aws_s3_bucket.collection.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "collection" {
  bucket = aws_s3_bucket.collection.id
  versioning_configuration { status = "Enabled" }
}

# Signed photo URLs are fetched by the browser from biomap.dot-y.co
resource "aws_s3_bucket_cors_configuration" "collection" {
  bucket = aws_s3_bucket.collection.id
  cors_rule {
    allowed_methods = ["GET"]
    allowed_origins = [trimsuffix(local.app_url, "/"), trimsuffix(local.dev_url, "/")]
    max_age_seconds = 3600
  }
}
