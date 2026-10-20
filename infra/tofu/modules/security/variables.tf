# Inputs of the security module (INFRA-003). Environment specifics are set by the calling root in
# environments/<env>/, never here.

variable "name_prefix" {
  description = "Prefix for every resource name, e.g. \"blackwing-dev\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,40}$", var.name_prefix))
    error_message = "name_prefix must be 2-41 characters of lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "vpc_id" {
  description = "ID of the VPC the security groups belong to (module.vpc.vpc_id)."
  type        = string

  validation {
    condition     = can(regex("^vpc-", var.vpc_id))
    error_message = "vpc_id must be a VPC ID such as vpc-0123456789abcdef0."
  }
}

variable "vpc_cidr_block" {
  description = "IPv4 CIDR of the VPC (module.vpc.vpc_cidr_block). Node egress to DNS and to interface VPC endpoints is limited to it."
  type        = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr_block, 0)) && var.vpc_cidr_block != "0.0.0.0/0"
    error_message = "vpc_cidr_block must be a valid, non-open CIDR."
  }
}

variable "k3s_api_port" {
  description = "k3s API server port (control-plane ingress from the agent tiers)."
  type        = number
  default     = 6443
}

variable "egress_proxy_port" {
  description = "Port of the egress gateway proxy on the egress nodes (the only port sandbox nodes may reach there)."
  type        = number
  default     = 3128

  validation {
    condition     = var.egress_proxy_port >= 1 && var.egress_proxy_port <= 65535 && floor(var.egress_proxy_port) == var.egress_proxy_port
    error_message = "egress_proxy_port must be a TCP port number."
  }
}

variable "lb_security_group_id" {
  description = "Security group of the load balancer allowed to reach the control-plane ingress NodePort. null: no load-balancer ingress (there is never public ingress)."
  type        = string
  default     = null
}

variable "lb_target_port" {
  description = "Port on the control-plane nodes the load balancer forwards to (only used when lb_security_group_id is set)."
  type        = number
  default     = 30443
}

variable "s3_prefix_list_id" {
  description = "Managed prefix list of the S3 gateway endpoint. When set, nodes may reach S3 on 443 through it (ECR image layers live in S3). null: no S3 egress."
  type        = string
  default     = null
}

variable "ecr_repository_arns" {
  description = "ECR repositories the nodes may pull from. Explicit ARNs only: wildcards are rejected."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.ecr_repository_arns : can(regex("^arn:aws[a-z-]*:ecr:[a-z0-9-]+:[0-9]{12}:repository/[^*]+$", arn))])
    error_message = "ecr_repository_arns must be explicit ECR repository ARNs without wildcards."
  }
}

variable "join_token_parameter_arns" {
  description = "SSM parameter ARNs holding the k3s join token (written by INFRA-004). Only the control-plane role may read them. Explicit ARNs only."
  type        = list(string)

  validation {
    condition     = length(var.join_token_parameter_arns) > 0 && alltrue([for arn in var.join_token_parameter_arns : can(regex("^arn:aws[a-z-]*:ssm:[a-z0-9-]+:[0-9]{12}:parameter/[^*]+$", arn))])
    error_message = "join_token_parameter_arns must be a non-empty list of explicit SSM parameter ARNs without wildcards."
  }
}

variable "join_token_kms_key_arn" {
  description = "KMS key encrypting the join-token SecureString. null when the AWS-managed key is used."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "Retention of the per-role node CloudWatch log groups, in days."
  type        = number
  default     = 365

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs retention value (e.g. 30, 90, 365, 731)."
  }
}

variable "log_kms_key_arn" {
  description = "Optional KMS key ARN encrypting the node log groups."
  type        = string
  default     = null
}

variable "enable_config_rules" {
  description = "Create the AWS Config rules (IMDSv2 required, no open SSH). Needs an AWS Config recorder in the account, so it is off by default."
  type        = bool
  default     = false
}
