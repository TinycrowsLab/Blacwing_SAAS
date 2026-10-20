# Provider requirements of the k3s module (INFRA-004). Kept in step with ../../versions.tf. The
# calling root supplies the configured aws provider, so no provider block is declared here.
terraform {
  required_version = "~> 1.8.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}
