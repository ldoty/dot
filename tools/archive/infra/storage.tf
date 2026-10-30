# The files: one private bucket, encrypted with the archive's own key, versioned so nothing is lost
# by mistake. Keys are ids, never names (f/<fileId> the file as uploaded, never rewritten; text/<fileId>.txt
# what intake read from it): folders and names live in the catalog, so a move or rename is a row update.
#
# Trash is a status in the catalog; deleting for good (page, the drawer's owner, from the trash only)
# deletes the object, and versioning keeps it 30 more days as a last chance, then it's gone.

resource "aws_kms_key" "files" {
  description             = "The family archive's files (tools/archive)"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  lifecycle { prevent_destroy = true }
}

resource "aws_kms_alias" "files" {
  name          = "alias/family-archive-files"
  target_key_id = aws_kms_key.files.key_id
}

resource "aws_s3_bucket" "files" {
  bucket_prefix = "family-archive-files-"
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "files" {
  bucket = aws_s3_bucket.files.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_versioning" "files" {
  bucket = aws_s3_bucket.files.id
  versioning_configuration { status = "Enabled" }
}

# The archive's key for everything; a bucket key keeps KMS requests (and their cost) down
resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.files.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  # A deleted or replaced object is kept 30 days, then gone
  rule {
    id     = "old-versions-30-days"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    expiration { expired_object_delete_marker = true }
  }
  rule {
    id     = "unfinished-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
  depends_on = [aws_s3_bucket_versioning.files]
}

# Only over TLS
resource "aws_s3_bucket_policy" "files" {
  bucket = aws_s3_bucket.files.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.files.arn, "${aws_s3_bucket.files.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.files]
}

# The page uploads straight to S3 from the browser (the same presigned PUT Claude Code uses)
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  cors_rule {
    allowed_origins = [trimsuffix(local.app_url, "/"), trimsuffix(local.dev_url, "/")]
    allowed_methods = ["PUT"]
    allowed_headers = ["content-type", "x-amz-checksum-sha256"]
    max_age_seconds = 600
  }
}

# Every new file goes to intake
resource "aws_s3_bucket_notification" "files" {
  bucket = aws_s3_bucket.files.id
  lambda_function {
    lambda_function_arn = aws_lambda_function.intake.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "f/"
  }
  depends_on = [aws_lambda_permission.intake]
}
