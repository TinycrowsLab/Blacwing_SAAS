# tflint configuration for every OpenTofu root (INFRA-001). Uses the bundled terraform ruleset
# only, so linting works offline.
config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "all"
}

# The shared inputs (environment, aws_region, aws_account_id) live in common_variables.tf, which is
# symlinked into every root so they cannot drift between roots (scripts/check-tofu.mjs enforces the
# symlinks). That is the one deliberate deviation from the standard file layout this rule checks;
# root-specific inputs still go in each root's variables.tf.
rule "terraform_standard_module_structure" {
  enabled = false
}
