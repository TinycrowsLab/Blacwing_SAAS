# Inputs of the k3s module (INFRA-004). Network and node-role wiring come from the vpc (INFRA-002)
# and security (INFRA-003) modules; nothing here is hardcoded per account or region.

variable "name_prefix" {
  description = "Prefix for every resource name, e.g. \"blackwing-dev\"."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name_prefix))
    error_message = "name_prefix must be 3-31 lowercase letters, digits or dashes and start with a letter."
  }
}

variable "environment" {
  description = "Deployment environment (dev, staging or prod). Names the SSM parameter path."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "aws_region" {
  description = "Region of the cluster. Used for the SSM / CloudWatch endpoints the nodes call at boot."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must look like eu-central-1."
  }
}

variable "aws_account_id" {
  description = "Account ID, for the KMS key policy (account root and the Auto Scaling service-linked role)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be 12 digits."
  }
}

variable "partition" {
  description = "AWS partition of the ARNs."
  type        = string
  default     = "aws"
}

variable "vpc_id" {
  description = "VPC of the cluster (vpc module output vpc_id)."
  type        = string
}

variable "vpc_cidr_block" {
  description = "VPC CIDR; the interface endpoints accept HTTPS from it."
  type        = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr_block, 0))
    error_message = "vpc_cidr_block must be a valid CIDR."
  }
}

variable "private_app_subnet_ids" {
  description = "Private-app subnets (one per AZ): control-plane, egress nodes and the internal API load balancer."
  type        = list(string)

  validation {
    condition     = length(var.private_app_subnet_ids) > 0
    error_message = "At least one private-app subnet is required."
  }
}

variable "sandbox_subnet_ids" {
  description = "Isolated sandbox subnets (no internet route, one per AZ): sandbox agents and the SSM / Logs interface endpoints."
  type        = list(string)

  validation {
    condition     = length(var.sandbox_subnet_ids) > 0
    error_message = "At least one sandbox subnet is required."
  }
}

variable "security_group_ids" {
  description = "Node security groups by role (security module output security_group_ids)."
  type = object({
    control-plane = string
    sandbox       = string
    egress        = string
  })
}

variable "instance_profile_names" {
  description = "Instance profile names by role (security module output instance_profile_names)."
  type = object({
    control-plane = string
    sandbox       = string
    egress        = string
  })
}

variable "iam_role_names" {
  description = "Node IAM role names by role (security module output iam_role_names); the SSM/KMS policies of this module attach to them."
  type = object({
    control-plane = string
    sandbox       = string
    egress        = string
  })
}

variable "log_group_names" {
  description = "CloudWatch log group per role (security module output node_log_group_names); nodes ship their bootstrap log there."
  type = object({
    control-plane = string
    sandbox       = string
    egress        = string
  })
}

variable "metadata_options" {
  description = "IMDS settings from the security module (output metadata_options). Must stay IMDSv2-only with hop limit 1."
  type = object({
    http_endpoint               = string
    http_tokens                 = string
    http_put_response_hop_limit = number
    instance_metadata_tags      = string
  })

  validation {
    condition     = var.metadata_options.http_tokens == "required" && var.metadata_options.http_put_response_hop_limit == 1 && var.metadata_options.http_endpoint == "enabled"
    error_message = "metadata_options must enforce IMDSv2 (http_tokens = required) with hop limit 1; never weaken it."
  }
}

# --- Pinned versions (CONTEXT_PACK §8 #9) ---------------------------------------------------

variable "k3s_version" {
  description = "Exact k3s release every node installs, e.g. v1.37.1+k3s1. Same value as K3S_VERSION in infra/k3s/versions.env."
  type        = string

  validation {
    condition     = can(regex("^v1\\.[0-9]+\\.[0-9]+\\+k3s[0-9]+$", var.k3s_version))
    error_message = "k3s_version must be an exact release such as v1.37.1+k3s1 (no ranges, no 'latest', no channel)."
  }
}

variable "k3s_sha256" {
  description = "sha256 of the k3s amd64 binary of k3s_version (from the release's sha256sum-amd64.txt)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.k3s_sha256))
    error_message = "k3s_sha256 must be 64 lowercase hex characters."
  }
}

variable "k3s_airgap_images_sha256" {
  description = "sha256 of k3s-airgap-images-amd64.tar.zst of k3s_version. The air-gapped sandbox nodes need it for the pause/system images."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.k3s_airgap_images_sha256))
    error_message = "k3s_airgap_images_sha256 must be 64 lowercase hex characters."
  }
}

variable "runsc_version" {
  description = "gVisor release installed on sandbox nodes (RUNSC_VERSION in infra/versions.env). INFRA-005 adds the RuntimeClass."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{8}(\\.[0-9]+)?$", var.runsc_version))
    error_message = "runsc_version must be a gVisor release such as 20261012.0."
  }
}

variable "runsc_sha512" {
  description = "sha512 of the gVisor x86_64 release bundle (RUNSC_SHA512_AMD64 in infra/versions.env)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{128}$", var.runsc_sha512))
    error_message = "runsc_sha512 must be 128 lowercase hex characters."
  }
}

variable "artifact_mirror_url" {
  description = "HTTPS base URL of the in-VPC artifact mirror (k3s/<version>/..., gvisor/<version>/x86_64/...). Required when the sandbox pool has nodes: it has no internet. null: nodes download from the upstream release sites."
  type        = string
  default     = null

  validation {
    condition     = var.artifact_mirror_url == null || can(regex("^https://[a-z0-9.-]+(/[A-Za-z0-9._/-]*)?[^/]$", var.artifact_mirror_url))
    error_message = "artifact_mirror_url must be an https:// URL without a trailing slash."
  }
}

variable "ami_id" {
  description = "AMI of every node (Ubuntu 24.04 LTS amd64). null: Canonical's current 24.04 gp3 AMI from its public SSM parameter. Pin it for staging and prod; the resolved ID is an output and an instance tag."
  type        = string
  default     = null

  validation {
    condition     = var.ami_id == null || can(regex("^ami-[0-9a-f]{8,17}$", var.ami_id))
    error_message = "ami_id must look like ami-0123456789abcdef0."
  }
}

# --- Pools ----------------------------------------------------------------------------------

variable "node_pools" {
  description = "Per-pool sizing. control-plane is a single node in v1 (documented single point of failure; HA is later). Fixed-size ASGs."
  type = object({
    control-plane = optional(object({
      instance_type  = optional(string, "t3.large")
      root_volume_gb = optional(number, 50)
      system_cpu     = optional(string, "250m")
      system_memory  = optional(string, "512Mi")
      kube_cpu       = optional(string, "250m")
      kube_memory    = optional(string, "512Mi")
      eviction_hard  = optional(string, "memory.available<256Mi")
    }), {})
    sandbox = optional(object({
      instance_type  = optional(string, "m6i.2xlarge")
      count          = optional(number, 2)
      root_volume_gb = optional(number, 200)
      system_cpu     = optional(string, "500m")
      system_memory  = optional(string, "1Gi")
      kube_cpu       = optional(string, "500m")
      kube_memory    = optional(string, "1Gi")
      eviction_hard  = optional(string, "memory.available<500Mi")
    }), {})
    egress = optional(object({
      instance_type  = optional(string, "m6i.large")
      count          = optional(number, 2)
      root_volume_gb = optional(number, 50)
      system_cpu     = optional(string, "250m")
      system_memory  = optional(string, "512Mi")
      kube_cpu       = optional(string, "250m")
      kube_memory    = optional(string, "512Mi")
      eviction_hard  = optional(string, "memory.available<256Mi")
    }), {})
  })
  default = {}

  validation {
    condition     = var.node_pools.sandbox.count >= 0 && var.node_pools.sandbox.count <= 50 && var.node_pools.egress.count >= 0 && var.node_pools.egress.count <= 20
    error_message = "node_pools: sandbox.count must be 0-50 and egress.count 0-20."
  }

  validation {
    condition = alltrue([
      for p in [var.node_pools.control-plane, var.node_pools.sandbox, var.node_pools.egress] :
      can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", p.instance_type)) && p.root_volume_gb >= 20 && p.root_volume_gb <= 2000
    ])
    error_message = "node_pools: instance_type must look like m6i.large and root_volume_gb must be 20-2000."
  }

  validation {
    condition = alltrue([
      for p in [var.node_pools.control-plane, var.node_pools.sandbox, var.node_pools.egress] :
      alltrue([for v in [p.system_cpu, p.kube_cpu] : can(regex("^[0-9]+m?$", v))]) &&
      alltrue([for v in [p.system_memory, p.kube_memory] : can(regex("^[0-9]+(Ki|Mi|Gi)$", v))]) &&
      can(regex("^[a-z.]+<[0-9]+(%|Ki|Mi|Gi)$", p.eviction_hard))
    ])
    error_message = "node_pools: reservations must be Kubernetes quantities (250m, 512Mi) and eviction_hard like memory.available<256Mi."
  }
}

variable "api_port" {
  description = "k3s API server port (security module k3s_api_port)."
  type        = number
  default     = 6443
}

variable "api_client_security_group_ids" {
  description = "Extra security groups (bastion, CI runner) allowed to reach the internal API load balancer. Never a CIDR."
  type        = list(string)
  default     = []
}

variable "create_interface_endpoints" {
  description = "Create the SSM and CloudWatch Logs interface endpoints in the sandbox subnets, which the air-gapped sandbox nodes need to read the join token and ship bootstrap logs. ECR/S3 endpoints belong to the ECR mirror issue (#840)."
  type        = bool
  default     = true
}

variable "bootstrap_max_attempts" {
  description = "Attempts of every retried bootstrap step (download, SSM, time sync, join) before the node gives up and reports failure."
  type        = number
  default     = 30

  validation {
    condition     = var.bootstrap_max_attempts >= 1 && var.bootstrap_max_attempts <= 200
    error_message = "bootstrap_max_attempts must be 1-200."
  }
}
