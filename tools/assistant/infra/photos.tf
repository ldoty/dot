# Photos texted or emailed to Dot: kept a week so Dot can look at them again later in the
# conversation (api/store.mjs, PHOTO_DAYS = 7), then deleted by the bucket itself. Private,
# encrypted at rest (S3's default), and only Dot's role reads or writes it.

resource "aws_s3_bucket" "photos" {
  bucket_prefix = "lukes-assistant-photos-"
}

resource "aws_s3_bucket_public_access_block" "photos" {
  bucket                  = aws_s3_bucket.photos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# A day past PHOTO_DAYS: the code stops showing a photo at 7 days, the bucket deletes it after 8
resource "aws_s3_bucket_lifecycle_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id
  rule {
    id     = "expire-after-8-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 8
    }
  }
}

resource "aws_iam_role_policy" "photos" {
  name = "photos"
  role = aws_iam_role.api.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.photos.arn}/*" },
      # Without it, reading a photo the bucket already deleted is AccessDenied rather than NoSuchKey
      { Effect = "Allow", Action = "s3:ListBucket", Resource = aws_s3_bucket.photos.arn },
    ]
  })
}
