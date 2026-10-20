# Offline tests for the security module (INFRA-003). The AWS provider is mocked: nothing here talks
# to AWS. Run with `tofu init -backend=false && tofu test` (infra/tofu/scripts/check.sh does both).

mock_provider "aws" {
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:eu-central-1:123456789012:log-group:/blackwing/blackwing-test/nodes/x"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/blackwing-test-node"
    }
  }

  mock_resource "aws_iam_instance_profile" {
    defaults = {
      arn = "arn:aws:iam::123456789012:instance-profile/blackwing-test-node"
    }
  }
}

# Mocked IDs are identical across resources of one type; distinct SG IDs let the tests tell the
# tiers apart.
override_resource {
  target = aws_security_group.control_plane
  values = { id = "sg-control-plane" }
}

override_resource {
  target = aws_security_group.sandbox
  values = { id = "sg-sandbox" }
}

override_resource {
  target = aws_security_group.egress
  values = { id = "sg-egress" }
}

variables {
  name_prefix    = "blackwing-test"
  vpc_id         = "vpc-0123456789abcdef0"
  vpc_cidr_block = "10.40.0.0/16"
  join_token_parameter_arns = [
    "arn:aws:ssm:eu-central-1:123456789012:parameter/blackwing/dev/k3s/join-token",
  ]
  ecr_repository_arns = [
    "arn:aws:ecr:eu-central-1:123456789012:repository/blackwing/sandbox",
  ]
}

run "creates_one_security_group_per_role_tagged_by_role" {
  command = apply

  assert {
    condition     = aws_security_group.control_plane.tags["NodeRole"] == "control-plane" && aws_security_group.sandbox.tags["NodeRole"] == "sandbox" && aws_security_group.egress.tags["NodeRole"] == "egress"
    error_message = "Each security group must be tagged with its NodeRole."
  }

  assert {
    condition     = length(output.security_group_ids) == 3 && length(output.instance_profile_names) == 3
    error_message = "Exactly three roles (control-plane, sandbox, egress) must get a security group and an instance profile."
  }
}

run "control_plane_ingress_is_api_from_agents_etcd_among_servers_and_no_cidr" {
  command = apply

  assert {
    condition = alltrue([
      for r in aws_vpc_security_group_ingress_rule.cp_api_from_agents :
      r.from_port == 6443 && r.to_port == 6443 && r.ip_protocol == "tcp"
    ]) && length(aws_vpc_security_group_ingress_rule.cp_api_from_agents) == 2
    error_message = "The k3s API (6443) must be reachable from exactly the two agent SGs."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.cp_api_from_agents["sandbox"].referenced_security_group_id == "sg-sandbox" && aws_vpc_security_group_ingress_rule.cp_api_from_agents["egress"].referenced_security_group_id == "sg-egress"
    error_message = "6443 must come from the sandbox and egress SGs only."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.cp_etcd_self.from_port == 2379 && aws_vpc_security_group_ingress_rule.cp_etcd_self.to_port == 2380 && aws_vpc_security_group_ingress_rule.cp_etcd_self.referenced_security_group_id == "sg-control-plane"
    error_message = "etcd ports 2379-2380 must be open among control-plane servers only."
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.cp_from_lb) == 0
    error_message = "Without a load balancer SG there must be no load-balancer ingress rule."
  }
}

run "control_plane_has_no_public_ingress_even_with_a_load_balancer" {
  command = apply

  variables {
    lb_security_group_id = "sg-0loadbalancer"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.cp_from_lb[0].referenced_security_group_id == "sg-0loadbalancer" && aws_vpc_security_group_ingress_rule.cp_from_lb[0].cidr_ipv4 == null
    error_message = "The load balancer is allowed by SG reference, never by CIDR."
  }

  assert {
    condition = alltrue(flatten([
      [for r in aws_vpc_security_group_ingress_rule.cp_api_from_agents : r.cidr_ipv4 == null],
      [for r in aws_vpc_security_group_ingress_rule.cp_vxlan : r.cidr_ipv4 == null],
      [aws_vpc_security_group_ingress_rule.cp_api_self.cidr_ipv4 == null, aws_vpc_security_group_ingress_rule.cp_etcd_self.cidr_ipv4 == null, aws_vpc_security_group_ingress_rule.cp_kubelet_self.cidr_ipv4 == null],
    ]))
    error_message = "No control-plane ingress rule may use a CIDR."
  }
}

run "sandbox_sg_has_no_inbound_from_any_cidr" {
  command = apply

  assert {
    condition = alltrue(flatten([
      [aws_vpc_security_group_ingress_rule.sandbox_kubelet.cidr_ipv4 == null],
      [for r in aws_vpc_security_group_ingress_rule.sandbox_vxlan : r.cidr_ipv4 == null && r.cidr_ipv6 == null],
    ]))
    error_message = "Sandbox nodes must accept inbound only from other cluster tiers, never from a CIDR."
  }
}

# Regression: the sandbox SG must never regain an open (0.0.0.0/0 or ::/0) egress rule.
run "sandbox_sg_has_no_open_egress" {
  command = apply

  assert {
    condition = alltrue(flatten([
      [for r in aws_vpc_security_group_egress_rule.sandbox_dns : r.cidr_ipv4 == "10.40.0.0/16"],
      [aws_vpc_security_group_egress_rule.sandbox_https_vpc.cidr_ipv4 == "10.40.0.0/16"],
      [aws_vpc_security_group_egress_rule.sandbox_api.cidr_ipv4 == null, aws_vpc_security_group_egress_rule.sandbox_to_egress_proxy.cidr_ipv4 == null],
      [for r in aws_vpc_security_group_egress_rule.sandbox_vxlan : r.cidr_ipv4 == null],
    ]))
    error_message = "Sandbox egress must be limited to the VPC CIDR or other cluster SGs; 0.0.0.0/0 is forbidden."
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.sandbox_to_egress_proxy.referenced_security_group_id == "sg-egress" && aws_vpc_security_group_egress_rule.sandbox_to_egress_proxy.from_port == 3128 && aws_vpc_security_group_egress_rule.sandbox_to_egress_proxy.to_port == 3128
    error_message = "Sandbox traffic leaves only through the egress gateway proxy (3128) on the egress SG."
  }

  assert {
    condition     = length(aws_vpc_security_group_egress_rule.sandbox_s3) == 0
    error_message = "No S3 egress without an S3 prefix list."
  }
}

run "egress_tier_accepts_proxy_from_sandbox_and_has_the_only_internet_egress" {
  command = apply

  assert {
    condition     = aws_vpc_security_group_ingress_rule.egress_proxy_from_sandbox.referenced_security_group_id == "sg-sandbox" && aws_vpc_security_group_ingress_rule.egress_proxy_from_sandbox.from_port == 3128 && aws_vpc_security_group_ingress_rule.egress_proxy_from_sandbox.cidr_ipv4 == null
    error_message = "The proxy port must be reachable from the sandbox SG only."
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.egress_internet.cidr_ipv4 == "0.0.0.0/0"
    error_message = "The egress tier must have internet egress."
  }
}

run "proxy_port_is_configurable_and_applied_on_both_sides" {
  command = apply

  variables {
    egress_proxy_port = 13128
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.egress_proxy_from_sandbox.from_port == 13128 && aws_vpc_security_group_egress_rule.sandbox_to_egress_proxy.to_port == 13128
    error_message = "The proxy port must be consistent between the egress ingress rule and the sandbox egress rule."
  }
}

run "s3_prefix_list_adds_s3_egress_for_pulls_only_on_cluster_tiers" {
  command = apply

  variables {
    s3_prefix_list_id = "pl-0123456789abcdef0"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.sandbox_s3[0].prefix_list_id == "pl-0123456789abcdef0" && aws_vpc_security_group_egress_rule.sandbox_s3[0].cidr_ipv4 == null
    error_message = "S3 egress must use the prefix list, not a CIDR."
  }
}

run "metadata_options_enforce_imdsv2_with_hop_limit_one" {
  command = apply

  assert {
    condition     = output.metadata_options.http_tokens == "required" && output.metadata_options.http_put_response_hop_limit == 1 && output.metadata_options.http_endpoint == "enabled"
    error_message = "IMDSv2 must be required with hop limit 1 and the endpoint enabled."
  }

  assert {
    condition     = output.metadata_options.instance_metadata_tags == "disabled"
    error_message = "Instance metadata tags must stay disabled."
  }
}

run "sandbox_role_has_only_ecr_read_and_log_writes" {
  command = apply

  assert {
    condition = alltrue(flatten([
      for p in [aws_iam_role_policy.logs["sandbox"].policy, aws_iam_role_policy.ecr_pull["sandbox"].policy] : [
        for s in jsondecode(p).Statement :
        can(regex("^\\[(\"(logs|ecr):[A-Za-z]+\",?)+\\]$", jsonencode(s.Action)))
      ]
    ]))
    error_message = "The sandbox role may only use explicit ecr: and logs: actions (no s3:*, ec2:*, ssm:* or wildcards)."
  }

  assert {
    condition = alltrue(flatten([
      for p in [aws_iam_role_policy.logs["sandbox"].policy, aws_iam_role_policy.ecr_pull["sandbox"].policy] : [
        for s in jsondecode(p).Statement :
        !can(regex("s3:|ec2:|ssm:|kms:|sts:|iam:", jsonencode(s.Action)))
      ]
    ]))
    error_message = "The sandbox role must not hold s3, ec2, ssm, kms, sts or iam permissions."
  }
}

run "wildcard_resources_are_limited_to_the_ecr_auth_token_action" {
  command = apply

  assert {
    condition = alltrue(flatten([
      for role in ["control-plane", "sandbox", "egress"] : [
        for p in [aws_iam_role_policy.logs[role].policy, aws_iam_role_policy.ecr_pull[role].policy] : [
          for s in jsondecode(p).Statement :
          s.Resource == "*" ? s.Action == ["ecr:GetAuthorizationToken"] : true
        ]
      ]
    ]))
    error_message = "Only ecr:GetAuthorizationToken (which has no resource-level support) may use Resource \"*\"."
  }

  assert {
    condition = alltrue(flatten([
      for role in ["control-plane", "sandbox", "egress"] : [
        for s in jsondecode(aws_iam_role_policy.ecr_pull[role].policy).Statement :
        s.Sid == "EcrAuthToken" ? true : s.Resource == ["arn:aws:ecr:eu-central-1:123456789012:repository/blackwing/sandbox"]
      ]
    ]))
    error_message = "ECR image-read actions must be pinned to the explicit repository ARNs."
  }
}

run "only_the_control_plane_reads_the_join_token_parameter" {
  command = apply

  assert {
    condition     = jsondecode(aws_iam_role_policy.join_token.policy).Statement[0].Action == ["ssm:GetParameter", "ssm:GetParameters"] && jsondecode(aws_iam_role_policy.join_token.policy).Statement[0].Resource == ["arn:aws:ssm:eu-central-1:123456789012:parameter/blackwing/dev/k3s/join-token"]
    error_message = "The join-token policy must read exactly the configured parameter ARNs."
  }

  assert {
    condition     = length(jsondecode(aws_iam_role_policy.join_token.policy).Statement) == 1
    error_message = "Without a KMS key there must be no kms:Decrypt statement."
  }
}

run "kms_decrypt_is_added_for_the_join_token_key_only_when_given" {
  command = apply

  variables {
    join_token_kms_key_arn = "arn:aws:kms:eu-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  }

  assert {
    condition     = jsondecode(aws_iam_role_policy.join_token.policy).Statement[1].Action == ["kms:Decrypt"] && jsondecode(aws_iam_role_policy.join_token.policy).Statement[1].Resource == ["arn:aws:kms:eu-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"]
    error_message = "kms:Decrypt must be limited to the given key."
  }
}

run "roles_are_assumable_only_by_ec2_and_have_instance_profiles" {
  command = apply

  assert {
    condition     = alltrue([for r in aws_iam_role.node : can(regex("ec2.amazonaws.com", r.assume_role_policy))])
    error_message = "Node roles must be assumable by the EC2 service only."
  }

  assert {
    condition     = alltrue([for role, p in aws_iam_instance_profile.node : p.name == "blackwing-test-${role}-node"])
    error_message = "Instance profiles must be named per role."
  }
}

run "config_rules_are_opt_in_and_created_when_enabled" {
  command = apply

  assert {
    condition     = length(aws_config_config_rule.imdsv2_required) == 0 && length(aws_config_config_rule.no_open_ssh) == 0
    error_message = "Config rules must be off by default."
  }
}

run "config_rules_enabled" {
  command = apply

  variables {
    enable_config_rules = true
  }

  assert {
    condition     = aws_config_config_rule.imdsv2_required[0].source[0].source_identifier == "EC2_IMDSV2_CHECK" && aws_config_config_rule.no_open_ssh[0].source[0].source_identifier == "INCOMING_SSH_DISABLED"
    error_message = "The IMDSv2 and open-SSH Config rules must be created when enabled."
  }
}

run "rejects_wildcard_ecr_repository_arns" {
  command = plan

  variables {
    ecr_repository_arns = ["arn:aws:ecr:eu-central-1:123456789012:repository/*"]
  }

  expect_failures = [var.ecr_repository_arns]
}

run "rejects_wildcard_join_token_parameter_arns" {
  command = plan

  variables {
    join_token_parameter_arns = ["arn:aws:ssm:eu-central-1:123456789012:parameter/*"]
  }

  expect_failures = [var.join_token_parameter_arns]
}

run "rejects_empty_join_token_parameter_arns" {
  command = plan

  variables {
    join_token_parameter_arns = []
  }

  expect_failures = [var.join_token_parameter_arns]
}

run "rejects_an_open_vpc_cidr_for_node_egress" {
  command = plan

  variables {
    vpc_cidr_block = "0.0.0.0/0"
  }

  expect_failures = [var.vpc_cidr_block]
}
