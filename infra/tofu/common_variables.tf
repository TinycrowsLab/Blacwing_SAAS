# Shared input variables (INFRA-001). Symlinked into every root. Account IDs are never hardcoded:
# pass aws_account_id with TF_VAR_aws_account_id (or -var) at init/plan/apply time.

variable "environment" {
  description = "Deployment environment. One of dev, staging, prod."
  type        = string
  nullable    = false

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "The environment must be one of dev, staging, prod. Check that you are using the terraform.tfvars of the directory you are in."
  }
}

variable "aws_region" {
  description = "AWS region of this environment and of its state backend, for example eu-central-1. Required: there is no default region."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]$", var.aws_region))
    error_message = "The aws_region must be an AWS region code such as eu-central-1. Set it in terraform.tfvars; AWS_REGION alone is not used."
  }
}

variable "aws_account_id" {
  description = "12-digit AWS account ID the environment lives in. Supply it with TF_VAR_aws_account_id; never commit it."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "The aws_account_id must be the 12-digit AWS account ID. Export TF_VAR_aws_account_id."
  }
}
