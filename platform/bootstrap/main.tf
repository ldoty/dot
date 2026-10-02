# The S3 bucket that holds remote state for every root, including this one.
# First run on a fresh account: comment out the backend block, apply, then
# restore it and run `tofu init -migrate-state` to move this state into the bucket.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {
    bucket       = "family-tfstate-921782276410"
    key          = "platform/bootstrap/terraform.tfstate"
    region       = "us-east-1"
    profile      = "ldoty"
    use_lockfile = true
  }
}

provider "aws" {
  region  = "us-east-1"
  profile = "ldoty"
  default_tags { tags = { project = "family", root = "bootstrap" } }
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "state" {
  bucket = "family-tfstate-${data.aws_caller_identity.current.account_id}"
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "state_bucket" { value = aws_s3_bucket.state.bucket }
