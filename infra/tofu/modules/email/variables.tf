variable "name_prefix" {
  description = "Name prefix of the environment, for example blackwing-dev. Used to name the IAM user, SNS topic, configuration set and alarms."
  type        = string
  nullable    = false
}

variable "domain_name" {
  description = "Application domain whose SES identity is verified (the INFRA-007 app zone name), for example blackwing.example."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain_name))
    error_message = "The domain_name must be a lower-case fully qualified domain without a trailing dot."
  }
}

variable "zone_id" {
  description = "Route53 hosted zone id of the application domain (INFRA-007 output app_zone_id). All DKIM, SPF, DMARC, MAIL FROM and verification records are written here."
  type        = string
  nullable    = false
}

variable "aws_region" {
  description = "Region of the SES endpoint (SMTP host, MAIL FROM MX target, IAM resource ARNs). SES must be available there."
  type        = string
  nullable    = false
}

variable "aws_account_id" {
  description = "Account that owns the SES identity; scopes the SNS topic policy and the IAM policy ARNs."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "The aws_account_id must be a 12-digit AWS account id."
  }
}

variable "mail_from_label" {
  description = "Single DNS label of the custom MAIL FROM subdomain, giving <label>.<domain_name>."
  type        = string
  default     = "mail"
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.mail_from_label))
    error_message = "The mail_from_label must be one lower-case DNS label (no dots)."
  }
}

variable "from_local_part" {
  description = "Local part of the default from-address handed to the application, giving <local>@<domain_name>."
  type        = string
  default     = "no-reply"
  nullable    = false
}

variable "dmarc_policy" {
  description = "DMARC policy: quarantine in prod; none is allowed for dev/staging while mail flows are validated."
  type        = string
  default     = "quarantine"
  nullable    = false

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "The dmarc_policy must be none, quarantine or reject."
  }
}

variable "dmarc_report_local_part" {
  description = "Local part of the aggregate-report mailbox (rua=mailto:<local>@<domain_name>). The mailbox must exist: see docs/runbooks/ses-email.md."
  type        = string
  default     = "dmarc"
  nullable    = false
}

variable "spf_qualifier" {
  description = "Terminal SPF mechanism for the domain and MAIL FROM records: -all (fail) or ~all (softfail)."
  type        = string
  default     = "-all"
  nullable    = false

  validation {
    condition     = contains(["-all", "~all"], var.spf_qualifier)
    error_message = "The spf_qualifier must be -all or ~all."
  }
}

variable "parameter_prefix" {
  description = "SSM Parameter Store path prefix for the SMTP credentials, for example /blackwing/prod/email. The values are SecureString parameters; applications and OpenBao read them by reference."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^/[A-Za-z0-9_./-]*[A-Za-z0-9_-]$", var.parameter_prefix))
    error_message = "The parameter_prefix must start with / and not end with /."
  }
}

variable "ssm_kms_key_id" {
  description = "KMS key (id, ARN or alias) encrypting the SecureString parameters. Null uses the AWS managed alias/aws/ssm key."
  type        = string
  default     = null
}

variable "rotation_overlap" {
  description = "Set true to create the second SMTP access key (two-key overlap) for zero-downtime rotation: roll consumers to the -next parameters, then retire the old key. See docs/runbooks/ses-email.md."
  type        = bool
  default     = false
  nullable    = false
}

variable "bounce_rate_alarm_threshold" {
  description = "Account bounce rate (fraction, 0.05 = 5%) above which the alarm fires. SES reviews accounts from 5%."
  type        = number
  default     = 0.04
  nullable    = false

  validation {
    condition     = var.bounce_rate_alarm_threshold > 0 && var.bounce_rate_alarm_threshold < 0.1
    error_message = "The bounce_rate_alarm_threshold must be between 0 and 0.1."
  }
}

variable "complaint_rate_alarm_threshold" {
  description = "Account complaint rate (fraction, 0.001 = 0.1%) above which the alarm fires. SES reviews accounts from 0.1%."
  type        = number
  default     = 0.0005
  nullable    = false

  validation {
    condition     = var.complaint_rate_alarm_threshold > 0 && var.complaint_rate_alarm_threshold < 0.01
    error_message = "The complaint_rate_alarm_threshold must be between 0 and 0.01."
  }
}

variable "alarm_actions" {
  description = "Extra ARNs notified by the bounce/complaint alarms in addition to the events topic (for example the ops paging topic)."
  type        = list(string)
  default     = []
  nullable    = false
}
