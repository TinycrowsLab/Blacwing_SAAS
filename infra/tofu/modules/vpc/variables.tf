# Inputs of the vpc module (INFRA-002). Environment specifics are set by the calling root in
# environments/<env>/, never here.

variable "name_prefix" {
  description = "Prefix for every resource Name tag, e.g. \"blackwing-dev\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,40}$", var.name_prefix))
    error_message = "name_prefix must be 2-41 characters of lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "Environment the VPC belongs to: dev, staging or prod. prod forbids single_nat."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of dev, staging or prod."
  }
}

variable "cidr_block" {
  description = <<-EOT
    IPv4 CIDR of the VPC. Must be an RFC 1918 range with a prefix between /16 and /24 and must not
    overlap any network that will be peered, VPN-attached or that customers route to (see the module
    README). Each tier subnet takes 1/16 of it.
  EOT
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition = (
      can(cidrhost(var.cidr_block, 0)) &&
      can(regex("^[0-9.]+/(1[6-9]|2[0-4])$", var.cidr_block)) &&
      cidrhost(var.cidr_block, 0) == split("/", var.cidr_block)[0]
    )
    error_message = "cidr_block must be a network address (host bits zero) with a prefix length between /16 and /24, e.g. 10.40.0.0/16."
  }

  validation {
    condition = can(cidrhost(var.cidr_block, 0)) && anytrue([
      for range in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] :
      cidrhost(range, 0) == cidrhost("${cidrhost(var.cidr_block, 0)}/${split("/", range)[1]}", 0)
    ])
    error_message = "cidr_block must lie inside an RFC 1918 private range (10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16)."
  }
}

variable "az_count" {
  description = "Number of availability zones to spread every tier across (2-4)."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 4 && floor(var.az_count) == var.az_count
    error_message = "az_count must be a whole number between 2 and 4 (multi-AZ is required)."
  }
}

variable "availability_zones" {
  description = "Explicit AZ names to use (first az_count are taken). Empty means the region's available AZs, in name order."
  type        = list(string)
  default     = []
}

variable "single_nat" {
  description = <<-EOT
    true: one NAT gateway (and one egress EIP) shared by every AZ, the cheap dev default.
    false: one NAT gateway with its own EIP per AZ (HA). Required in prod; single_nat = true is
    rejected when environment = "prod". null picks true outside prod and false in prod.
  EOT
  type        = bool
  default     = null
}

variable "eip_quota" {
  description = "Elastic IPs this module may allocate in the account/region (the AWS default quota is 5 per region). Planning fails clearly when the NATs need more."
  type        = number
  default     = 5

  validation {
    condition     = var.eip_quota >= 1 && floor(var.eip_quota) == var.eip_quota
    error_message = "eip_quota must be a positive whole number."
  }
}

variable "flow_log_destination" {
  description = "Where VPC Flow Logs go: \"cloud-watch-logs\" (a log group created here) or \"s3\" (flow_log_s3_bucket_arn)."
  type        = string
  default     = "cloud-watch-logs"

  validation {
    condition     = contains(["cloud-watch-logs", "s3"], var.flow_log_destination)
    error_message = "flow_log_destination must be \"cloud-watch-logs\" or \"s3\"."
  }
}

variable "flow_log_s3_bucket_arn" {
  description = "ARN of the S3 bucket (optionally with a /prefix) receiving flow logs when flow_log_destination = \"s3\"."
  type        = string
  default     = null

  validation {
    condition     = var.flow_log_s3_bucket_arn == null || can(regex("^arn:aws[a-z-]*:s3:::[a-z0-9.-]{3,63}(/.*)?$", var.flow_log_s3_bucket_arn))
    error_message = "flow_log_s3_bucket_arn must be an S3 bucket ARN such as arn:aws:s3:::my-bucket or arn:aws:s3:::my-bucket/prefix."
  }
}

variable "flow_log_retention_days" {
  description = "Retention of the CloudWatch flow-log group, in days."
  type        = number
  default     = 365

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.flow_log_retention_days)
    error_message = "flow_log_retention_days must be a CloudWatch Logs retention value (e.g. 30, 90, 365, 731)."
  }
}

variable "flow_log_kms_key_arn" {
  description = "Optional KMS key ARN encrypting the CloudWatch flow-log group. null uses the CloudWatch default encryption."
  type        = string
  default     = null
}
