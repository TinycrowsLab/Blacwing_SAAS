variable "environment" {
  description = "Deployment environment (dev, staging, prod). Used in bucket and alias names."
  type        = string
  nullable    = false
}

variable "aws_account_id" {
  description = "12-digit AWS account ID. Used for the KMS key administration principal."
  type        = string
  nullable    = false
}

variable "name_prefix" {
  description = "Bucket name prefix. Buckets are named <name_prefix>-evidence, -exports, -backups and -transcripts. Defaults to bw-<environment>."
  type        = string
  default     = null
}

variable "app_role_arn" {
  description = "ARN of the application IAM role that reads and writes the buckets. It receives kms:Encrypt/Decrypt/GenerateDataKey only with the tenantId encryption context. The role itself is created by a later INFRA issue and must exist before apply."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$", var.app_role_arn))
    error_message = "app_role_arn must be an IAM role ARN."
  }
}

variable "access_log_bucket" {
  description = "Name of the existing S3 server access log bucket (the INFRA-001 bootstrap log bucket)."
  type        = string
  nullable    = false
}

variable "evidence_retention_days" {
  description = "Default Object Lock COMPLIANCE retention of the evidence bucket, in days. Enforced by S3 server time; it cannot be shortened by anyone, including the account root."
  type        = number
  default     = 30

  validation {
    condition     = var.evidence_retention_days >= 1 && var.evidence_retention_days == floor(var.evidence_retention_days)
    error_message = "evidence_retention_days must be a whole number of days, at least 1."
  }
}

variable "evidence_noncurrent_expiration_days" {
  description = "Days after which non-current evidence versions are removed. Must exceed evidence_retention_days so lifecycle never races Object Lock."
  type        = number
  default     = 365
}

variable "exports_retention_days" {
  description = "Days after which report/export objects expire."
  type        = number
  default     = 90

  validation {
    condition     = var.exports_retention_days >= 1
    error_message = "exports_retention_days must be at least 1."
  }
}

variable "transcripts_retention_days" {
  description = "Days after which agent transcript objects expire."
  type        = number
  default     = 180

  validation {
    condition     = var.transcripts_retention_days >= 1
    error_message = "transcripts_retention_days must be at least 1."
  }
}

variable "backups_retention_days" {
  description = "Days after which backup objects expire."
  type        = number
  default     = 35

  validation {
    condition     = var.backups_retention_days >= 1
    error_message = "backups_retention_days must be at least 1."
  }
}

variable "noncurrent_version_expiration_days" {
  description = "Days after which non-current versions of exports, backups and transcripts are removed."
  type        = number
  default     = 30
}

variable "kms_deletion_window_days" {
  description = "Waiting period before a scheduled KMS key deletion takes effect."
  type        = number
  default     = 30
}

variable "denied_requests_alarm_threshold" {
  description = "Number of 4xx (403/AccessDenied) requests per 5 minutes on one bucket that raises the alarm."
  type        = number
  default     = 10
}

variable "alarm_actions" {
  description = "ARNs notified (for example an SNS topic) when the denied-request alarm fires."
  type        = list(string)
  default     = []
}

variable "data_event_retention_days" {
  description = "Retention of the CloudTrail Lake event data store holding S3 data events for the four buckets (7 to 2555)."
  type        = number
  default     = 2555

  validation {
    condition     = var.data_event_retention_days >= 7 && var.data_event_retention_days <= 2555
    error_message = "data_event_retention_days must be between 7 and 2555."
  }
}
