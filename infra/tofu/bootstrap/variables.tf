# Bootstrap-only inputs. environment, aws_region and aws_account_id come from the shared
# common_variables.tf (symlink).

variable "state_admin_principal_arns" {
  description = "IAM principal ARNs (the ops role, and the role that runs bootstrap) allowed to access the state bucket. Everyone else is denied by the bucket policy. Wildcards are allowed, e.g. arn:aws:iam::<account>:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_BlackwingOps_*."
  type        = list(string)
  nullable    = false

  validation {
    condition     = length(var.state_admin_principal_arns) > 0 && alltrue([for arn in var.state_admin_principal_arns : can(regex("^arn:aws[a-z-]*:(iam|sts)::[0-9]{12}:", arn))])
    error_message = "The state_admin_principal_arns must list at least one IAM/STS principal ARN; an empty list would lock everyone out of the state."
  }
}

variable "noncurrent_version_expiration_days" {
  description = "Days after which noncurrent state (and log) object versions are expired."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_expiration_days >= 30
    error_message = "Keep noncurrent state versions for at least 30 days so a bad apply can be rolled back."
  }
}

variable "access_log_retention_days" {
  description = "Days to keep S3 server access logs and CloudTrail files for the state bucket."
  type        = number
  default     = 365

  validation {
    condition     = var.access_log_retention_days >= 90
    error_message = "Keep state access logs for at least 90 days."
  }
}
