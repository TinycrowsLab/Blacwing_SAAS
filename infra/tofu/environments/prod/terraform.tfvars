# prod environment. aws_account_id is NOT set here: export TF_VAR_aws_account_id.
environment = "prod"
aws_region  = "eu-central-1"

# Network (INFRA-002). Each environment has its own non-overlapping range; one NAT per AZ for HA (distinct egress EIPs).
vpc_cidr_block = "10.42.0.0/16"
vpc_az_count   = 3
vpc_single_nat = false

# DNS (INFRA-007). Placeholder domain: replace with the registered domain of this environment
# before the first apply. Every environment needs its own domain.
domain_name = "blackwing.example"
