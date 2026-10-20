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
  command = apply

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
