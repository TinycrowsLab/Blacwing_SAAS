# Inputs specific to the staging environment. The shared inputs (environment, aws_region,
# aws_account_id) live in common_variables.tf. Modules added by later INFRA issues declare their
# environment-specific inputs here and set them in terraform.tfvars.

variable "vpc_cidr_block" {
  description = "IPv4 CIDR of this environment's VPC (RFC 1918, must not overlap peered or customer networks)."
  type        = string
}

variable "vpc_az_count" {
  description = "Availability zones the VPC tiers span."
  type        = number
}

variable "vpc_single_nat" {
  description = "One shared NAT gateway (true) or one per AZ (false). prod rejects true."
  type        = bool
}

variable "vpc_eip_quota" {
  description = "Elastic IPs the VPC NAT gateways may use in this account/region (AWS default quota: 5)."
  type        = number
  default     = 5
}
