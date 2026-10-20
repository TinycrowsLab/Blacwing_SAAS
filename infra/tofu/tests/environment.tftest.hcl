# Offline tests for every environment root (INFRA-001). Symlinked into
# environments/<env>/tests/. Run with `tofu init -backend=false && tofu test` (infra/tofu/scripts/check.sh).
# The AWS provider is mocked: nothing here talks to AWS.

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["eu-central-1a", "eu-central-1b", "eu-central-1c"]
    }
  }

  # The provider validates ARN syntax, so mocked ARNs must look like ARNs.
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:eu-central-1:123456789012:log-group:/blackwing/mock/vpc-flow-logs"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/mock-vpc-flow-logs"
    }
  }

  # The egress-IP list validates its input as public IPv4, so the mocked EIP must be one.
  mock_resource "aws_eip" {
    defaults = {
      public_ip = "203.0.113.10"
    }
  }

  mock_resource "aws_vpc" {
    defaults = {
      id = "vpc-0123456789abcdef0"
    }
  }

  mock_resource "aws_iam_instance_profile" {
    defaults = {
      arn = "arn:aws:iam::123456789012:instance-profile/mock-node"
    }
  }
}

mock_provider "aws" {
  alias = "us_east_1"

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/aws/route53/mock"
    }
  }

  # CloudFront validates the certificate ARN it is given (egress-IP list, INFRA-015).
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555"
    }
  }
}

variables {
  # Placeholder account for the mocked provider; real runs take TF_VAR_aws_account_id.
  aws_account_id = "123456789012"
}

run "tfvars_select_this_environment" {
  command = plan

  assert {
    condition     = contains(["dev", "staging", "prod"], output.environment)
    error_message = "terraform.tfvars must set a valid environment."
  }

  assert {
    condition     = output.state_key == "blackwing/${var.environment}/terraform.tfstate"
    error_message = "State key must be blackwing/<env>/terraform.tfstate."
  }
}

run "common_tags_follow_the_convention" {
  command = plan

  assert {
    condition = (
      output.common_tags.Project == "blackwing" &&
      output.common_tags.Environment == var.environment &&
      output.common_tags.ManagedBy == "opentofu" &&
      length(output.common_tags) == 3
    )
    error_message = "common_tags must be exactly Project=blackwing, Environment=<env>, ManagedBy=opentofu."
  }
}

run "rejects_unknown_environment" {
  command = plan

  variables {
    environment = "qa"
  }

  expect_failures = [var.environment]
}

run "rejects_missing_or_malformed_region" {
  command = plan

  variables {
    aws_region = "europe"
  }

  expect_failures = [var.aws_region]
}

run "rejects_malformed_account_id" {
  command = plan

  variables {
    aws_account_id = "12345"
  }

  expect_failures = [var.aws_account_id]
}

# INFRA-002: every environment gets the VPC with an isolated sandbox tier and static egress IPs.
# The module's own tests (modules/vpc/tests) cover the route tables and the prod single-NAT guard.
run "vpc_is_wired_with_isolated_sandbox_and_egress_ips" {
  command = plan

  assert {
    condition = (
      length(output.subnet_ids["sandbox"]) == var.vpc_az_count &&
      length(output.subnet_ids["private-app"]) == var.vpc_az_count &&
      length(output.subnet_ids["public"]) == var.vpc_az_count
    )
    error_message = "Every tier needs one subnet per AZ."
  }

  assert {
    condition     = length(output.route_table_ids["sandbox"]) == 1
    error_message = "Sandbox subnets share one route table without a default route."
  }

  assert {
    condition     = length(output.egress_ips) == (output.vpc_single_nat ? 1 : var.vpc_az_count)
    error_message = "egress_ips must hold one EIP per NAT gateway."
  }

  assert {
    condition     = var.environment != "prod" || (output.vpc_single_nat == false && var.vpc_az_count >= 2)
    error_message = "prod must run one NAT per AZ across at least two AZs."
  }
}

run "dns_outputs_are_consumable_by_later_issues" {
  command = plan

  assert {
    condition     = output.dns_oob_domain == "oob.${var.domain_name}" && output.dns_oob_wildcard_base == "*.oob.${var.domain_name}"
    error_message = "The OOB domain and wildcard base must derive from the environment's domain_name."
  }

  assert {
    condition     = output.dns_app_zone_id != null && output.dns_app_name_servers != null && length(output.dns_oob_ns_set) == 2
    error_message = "Zone id, registrar name servers and the OOB NS set must be output for INFRA-008, INFRA-012 and the registrar hand-off."
  }
}

# INFRA-015: the egress-IP list URL is derived from the environment's domain. That the list itself
# comes from module.vpc.egress_ips is checked by scripts/check-egress-ips.test.mjs, and the
# published-equals-input property by modules/egress-ips/tests.
run "egress_ip_list_url_follows_the_domain" {
  command = plan

  assert {
    condition     = output.egress_ips_url == "https://egress.${var.domain_name}/.well-known/blackwing-egress-ips.json"
    error_message = "The egress-IP list URL must be https://egress.<domain>/.well-known/blackwing-egress-ips.json."
  }
}

run "rejects_malformed_domain_name" {
  command = plan

  variables {
    domain_name = "Not A Domain."
  }

  expect_failures = [var.domain_name]
}

run "rejects_private_oob_server_address" {
  command = plan

  variables {
    oob_server_ips = ["192.168.1.10"]
  }

  expect_failures = [var.oob_server_ips]
}
