# Offline tests for every environment root (INFRA-001). Symlinked into
# environments/<env>/tests/. Run with `tofu init -backend=false && tofu test` (infra/tofu/scripts/check.sh).
# The AWS provider is mocked: nothing here talks to AWS.

mock_provider "aws" {}

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
