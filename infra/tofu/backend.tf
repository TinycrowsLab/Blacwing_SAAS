# Shared remote state backend (INFRA-001). Symlinked into every environment root and bootstrap/.
#
# OpenTofu >= 1.8 evaluates variables early, so bucket, key and KMS key come from the root's own
# variables: one state object per environment, and one bucket, lock table and KMS key per account
# and region (all created by bootstrap/). Locking is a conditional write to DynamoDB: a second
# concurrent plan/apply fails with "Error acquiring the state lock" instead of corrupting state.
# Object Lock is deliberately NOT used on the state bucket (it would block state overwrites).
terraform {
  backend "s3" {
    bucket         = "blackwing-tfstate-${var.aws_account_id}-${var.aws_region}"
    key            = "blackwing/${var.environment}/terraform.tfstate"
    region         = var.aws_region
    dynamodb_table = "blackwing-tfstate-lock"
    encrypt        = true
    kms_key_id     = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:alias/blackwing-tfstate"
  }
}
