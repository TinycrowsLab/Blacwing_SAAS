# staging environment. aws_account_id is NOT set here: export TF_VAR_aws_account_id.
environment = "staging"
aws_region  = "eu-central-1"

# Network (INFRA-002). Each environment has its own non-overlapping range; one shared NAT (one egress EIP) to save cost.
vpc_cidr_block = "10.41.0.0/16"
vpc_az_count   = 2
vpc_single_nat = true

# DNS (INFRA-007). Placeholder domain: replace with the registered domain of this environment
# before the first apply. Every environment needs its own domain.
domain_name = "staging.blackwing.example"
