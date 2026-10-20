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

# k3s nodes (INFRA-004). Must equal infra/k3s/versions.env and infra/versions.env (enforced by scripts/k3s-node-bootstrap.test.mjs).
k3s_version              = "v1.37.1+k3s1"
k3s_sha256               = "92b94582eb7b34a8cf532e6006842b9ed215a6783cf56a3dd6271fd35243b2c0"
k3s_airgap_images_sha256 = "865b2a63ad7a63fc0db17b7fc2985bf4ae11d5ae93ca1472be6218d20aeb6b23"
runsc_version            = "20261012.0"
runsc_sha512             = "9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e"
