# Seeds the throwaway local backend used by ../run.sh: a versioned bucket (MinIO) and the lock
# table (DynamoDB Local) with the exact names and key schema bootstrap/ creates on AWS.
# Never applied against AWS: the provider only accepts the local endpoints passed in by run.sh.

terraform {
  required_version = "~> 1.8.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}

variable "s3_endpoint" {
  type = string

  validation {
    condition     = can(regex("^http://127\\.0\\.0\\.1:[0-9]+$", var.s3_endpoint))
    error_message = "The seed only runs against a local endpoint."
  }
}

variable "dynamodb_endpoint" {
  type = string

  validation {
    condition     = can(regex("^http://127\\.0\\.0\\.1:[0-9]+$", var.dynamodb_endpoint))
    error_message = "The seed only runs against a local endpoint."
  }
}

variable "bucket" {
  type = string
}

provider "aws" {
  region                      = "eu-central-1"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  s3_use_path_style           = true

  endpoints {
    s3       = var.s3_endpoint
    dynamodb = var.dynamodb_endpoint
  }
}

resource "aws_s3_bucket" "state" {
  bucket = var.bucket
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_dynamodb_table" "lock" {
  name         = "blackwing-tfstate-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
