# Shared AWS provider configuration (INFRA-001). Symlinked into every root.
#
# - allowed_account_ids makes a run against the wrong account (wrong AWS_PROFILE) fail before any
#   change is computed.
# - default_tags puts common_tags on every taggable resource, so modules never repeat them and
#   per-resource tag drift cannot happen. Modules may add extra tags with `tags = { ... }`, but must
#   not set the common_tags keys.
# - Credentials come from the standard AWS chain (AWS_PROFILE, SSO, instance role). With none, the
#   provider stops at the first plan with "No valid credential sources found".

locals {
  common_tags = {
    Project     = "blackwing"
    Environment = var.environment
    ManagedBy   = "opentofu"
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.common_tags
  }
}

# Second configuration of the same account for the few services that only exist in us-east-1
# (Route53 query-log delivery, INFRA-007). Modules receive it as aws.us_east_1.
provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = [var.aws_account_id]

  default_tags {
    tags = local.common_tags
  }
}
