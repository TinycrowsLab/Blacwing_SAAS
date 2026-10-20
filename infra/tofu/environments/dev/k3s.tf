# k3s cluster (INFRA-004): control-plane + sandbox / egress agent pools. See modules/k3s.
#
# The pinned versions live in terraform.tfvars and must equal infra/k3s/versions.env (k3s) and
# infra/versions.env (runsc); scripts/k3s-node-bootstrap.test.mjs enforces that.
#
# The sandbox pool has no internet, so every node downloads its artifacts from the in-VPC mirror
# bucket (reached through the S3 gateway endpoint of #840). Layout:
#   <mirror>/k3s/<k3s_version>/{k3s,k3s-airgap-images-amd64.tar.zst}
#   <mirror>/gvisor/<runsc_version>/x86_64/gvisor.tar.bz2

variable "k3s_version" {
  description = "Exact k3s release of every node (same as K3S_VERSION in infra/k3s/versions.env)."
  type        = string
}

variable "k3s_sha256" {
  description = "sha256 of the k3s amd64 binary (K3S_SHA256_AMD64 in infra/k3s/versions.env)."
  type        = string
}

variable "k3s_airgap_images_sha256" {
  description = "sha256 of k3s-airgap-images-amd64.tar.zst of k3s_version."
  type        = string
}

variable "runsc_version" {
  description = "gVisor release of the sandbox nodes (RUNSC_VERSION in infra/versions.env)."
  type        = string
}

variable "runsc_sha512" {
  description = "sha512 of the gVisor x86_64 bundle (RUNSC_SHA512_AMD64 in infra/versions.env)."
  type        = string
}

variable "k3s_node_ami_id" {
  description = "Pinned node AMI (Ubuntu 24.04 amd64). null: Canonical's current 24.04 AMI (recorded as an output)."
  type        = string
  default     = null
}

variable "k3s_artifact_mirror_url" {
  description = "Base URL of the in-VPC node artifact mirror. null: the environment's node-artifacts bucket."
  type        = string
  default     = null
}

locals {
  k3s_artifact_mirror_url = coalesce(var.k3s_artifact_mirror_url, "https://${local.name_prefix}-node-artifacts.s3.${var.aws_region}.amazonaws.com")
}

module "k3s" {
  source = "../../modules/k3s"

  name_prefix    = local.name_prefix
  environment    = var.environment
  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id

  vpc_id                 = module.vpc.vpc_id
  vpc_cidr_block         = module.vpc.vpc_cidr_block
  private_app_subnet_ids = module.vpc.subnet_ids["private-app"]
  sandbox_subnet_ids     = module.vpc.subnet_ids["sandbox"]

  security_group_ids     = module.security.security_group_ids
  instance_profile_names = module.security.instance_profile_names
  iam_role_names         = module.security.iam_role_names
  log_group_names        = module.security.node_log_group_names
  metadata_options       = module.security.metadata_options

  k3s_version              = var.k3s_version
  k3s_sha256               = var.k3s_sha256
  k3s_airgap_images_sha256 = var.k3s_airgap_images_sha256
  runsc_version            = var.runsc_version
  runsc_sha512             = var.runsc_sha512
  artifact_mirror_url      = local.k3s_artifact_mirror_url
  ami_id                   = var.k3s_node_ami_id
}

output "k3s_version" {
  description = "k3s release pinned on every node."
  value       = module.k3s.k3s_version
}

output "k3s_api_url" {
  description = "Internal k3s API URL (agents and the exported kubeconfig)."
  value       = module.k3s.api_url
}

output "k3s_autoscaling_group_names" {
  description = "Auto Scaling group per node pool."
  value       = module.k3s.autoscaling_group_names
}

output "k3s_node_ami_id" {
  description = "AMI of the k3s nodes."
  value       = module.k3s.node_ami_id
}

output "k3s_kubeconfig_parameter_arn" {
  description = "SSM SecureString holding the admin kubeconfig (ops/CI only)."
  value       = module.k3s.kubeconfig_parameter_arn
}
