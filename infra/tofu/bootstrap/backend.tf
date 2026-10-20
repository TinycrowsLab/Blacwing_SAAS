# Bootstrap state lives in the bucket bootstrap itself creates, under its own key (one per region).
# The very first apply runs with a gitignored backend_override.tf that selects the local backend;
# afterwards `tofu init -migrate-state` moves the state here. See ../README.md "Bootstrap".
terraform {
  backend "s3" {
    bucket         = "blackwing-tfstate-${var.aws_account_id}-${var.aws_region}"
    key            = "blackwing/bootstrap/${var.aws_region}/terraform.tfstate"
    region         = var.aws_region
    dynamodb_table = "blackwing-tfstate-lock"
    encrypt        = true
    kms_key_id     = "arn:aws:kms:${var.aws_region}:${var.aws_account_id}:alias/blackwing-tfstate"
  }
}
