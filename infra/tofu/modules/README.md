# Reusable OpenTofu modules

One directory per module (`modules/<name>/` with `main.tf`, `variables.tf`, `outputs.tf`), composed
by the environment roots in `../environments/<env>/main.tf`. Modules arrive with their own issues
(network INFRA-002, node pools INFRA-004, buckets INFRA-006, ...).

Rules for every module:

- Do not declare a `provider` block; the environment root passes its configured `aws` provider.
- Do not set the `Project`, `Environment` or `ManagedBy` tags; the provider's `default_tags` adds
  `common_tags` to every resource. Extra, module-specific tags are fine.
- No hardcoded account IDs, regions or ARNs; take them as variables.
