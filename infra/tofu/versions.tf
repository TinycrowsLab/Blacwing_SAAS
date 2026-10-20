# Shared toolchain pins (INFRA-001). Symlinked into every root under environments/ and into
# bootstrap/, so the OpenTofu and provider versions cannot drift between roots. Keep
# required_version in step with .opentofu-version (scripts/check.sh enforces it).
terraform {
  required_version = "~> 1.8.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.80"
    }
  }
}
