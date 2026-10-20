# Offline tests for the k3s module (INFRA-004). The AWS provider is mocked: nothing here talks to
# AWS. Run with `tofu init -backend=false && tofu test` (infra/tofu/scripts/check.sh does both).
# The node bootstrap itself is tested by scripts/k3s-node-bootstrap.test.mjs.

mock_provider "aws" {
  mock_data "aws_default_tags" {
    defaults = {
      tags = { Project = "blackwing", Environment = "dev", ManagedBy = "opentofu" }
    }
  }

  mock_data "aws_ssm_parameter" {
    defaults = {
      insecure_value = "ami-0fedcba9876543210"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:eu-central-1:123456789012:key/11111111-2222-3333-4444-555555555555"
      key_id = "11111111-2222-3333-4444-555555555555"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:eu-central-1:123456789012:loadbalancer/net/blackwing-test-k3s-api/0123456789abcdef"
      dns_name = "blackwing-test-k3s-api-0123456789abcdef.elb.eu-central-1.amazonaws.com"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/blackwing-test-k3s-api/0123456789abcdef"
    }
  }

  mock_resource "aws_launch_template" {
    defaults = {
      id             = "lt-0123456789abcdef0"
      latest_version = 7
    }
  }

  mock_resource "aws_ssm_parameter" {
    defaults = {
      arn = "arn:aws:ssm:eu-central-1:123456789012:parameter/blackwing/dev/k3s/x"
    }
  }
}

override_resource {
  target = aws_security_group.api_lb
  values = { id = "sg-api-lb" }
}

variables {
  name_prefix            = "blackwing-test"
  environment            = "dev"
  aws_region             = "eu-central-1"
  aws_account_id         = "123456789012"
  vpc_id                 = "vpc-0123456789abcdef0"
  vpc_cidr_block         = "10.40.0.0/16"
  private_app_subnet_ids = ["subnet-app-a", "subnet-app-b"]
  sandbox_subnet_ids     = ["subnet-sbx-a", "subnet-sbx-b"]
  security_group_ids = {
    control-plane = "sg-control-plane"
    sandbox       = "sg-sandbox"
    egress        = "sg-egress"
  }
  instance_profile_names = {
    control-plane = "blackwing-test-control-plane"
    sandbox       = "blackwing-test-sandbox"
    egress        = "blackwing-test-egress"
  }
  iam_role_names = {
    control-plane = "blackwing-test-control-plane-node"
    sandbox       = "blackwing-test-sandbox-node"
    egress        = "blackwing-test-egress-node"
  }
  log_group_names = {
    control-plane = "/blackwing/blackwing-test/nodes/control-plane"
    sandbox       = "/blackwing/blackwing-test/nodes/sandbox"
    egress        = "/blackwing/blackwing-test/nodes/egress"
  }
  metadata_options = {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }
  k3s_version              = "v1.37.1+k3s1"
  k3s_sha256               = "92b94582eb7b34a8cf532e6006842b9ed215a6783cf56a3dd6271fd35243b2c0"
  k3s_airgap_images_sha256 = "865b2a63ad7a63fc0db17b7fc2985bf4ae11d5ae93ca1472be6218d20aeb6b23"
  runsc_version            = "20261012.0"
  runsc_sha512             = "9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e"
  artifact_mirror_url      = "https://blackwing-test-node-artifacts.s3.eu-central-1.amazonaws.com"
}

run "every_pool_is_labelled_and_pins_the_same_k3s_version" {
  command = apply

  assert {
    condition = alltrue([
      for pool, ud in {
        control-plane = base64decode(aws_launch_template.control_plane.user_data)
        sandbox       = base64decode(aws_launch_template.agent["sandbox"].user_data)
        egress        = base64decode(aws_launch_template.agent["egress"].user_data)
      } : strcontains(ud, "blackwing.io/pool=${pool}") && strcontains(ud, "BW_K3S_VERSION='v1.37.1+k3s1'") && startswith(ud, "#cloud-config\n")
    ])
    error_message = "Every pool's cloud-init must label its nodes blackwing.io/pool=<pool> and pin k3s_version."
  }

  assert {
    condition     = alltrue([for pool, asg in aws_autoscaling_group.pool : contains([for t in asg.tag : t.value if t.key == "blackwing.io/k3s"], "v1.37.1+k3s1")])
    error_message = "The pinned k3s version is recorded as a tag on every pool (§8 #9)."
  }

  assert {
    condition     = output.k3s_version == "v1.37.1+k3s1" && output.pool_labels["sandbox"]["blackwing.io/pool"] == "sandbox"
    error_message = "Outputs must expose the pinned version and the pool labels."
  }
}

run "user_data_carries_no_secret" {
  command = apply

  assert {
    condition = alltrue([
      for ud in [
        base64decode(aws_launch_template.control_plane.user_data),
        base64decode(aws_launch_template.agent["sandbox"].user_data),
        base64decode(aws_launch_template.agent["egress"].user_data),
      ] : !strcontains(ud, "K3S_TOKEN") && !can(regex("(?m)^\\s*\"?(token|agent-token)\"?\\s*:", ud)) && strcontains(ud, "token-file")
    ])
    error_message = "User-data must reference token files filled from SSM at boot, never carry a token."
  }

  assert {
    condition     = alltrue([for p in aws_ssm_parameter.secure : p.type == "SecureString"])
    error_message = "Join tokens and kubeconfig must be SecureStrings."
  }

  assert {
    condition     = alltrue([for p in aws_ssm_parameter.secure : p.key_id == aws_kms_key.nodes.arn])
    error_message = "Join tokens and kubeconfig must be encrypted with the module's KMS key."
  }


  assert {
    condition     = aws_ssm_parameter.secure["kubeconfig"].tier == "Advanced"
    error_message = "The kubeconfig needs the Advanced tier (over 4 KB with embedded certificates)."
  }
}

run "root_volumes_are_kms_encrypted_gp3_and_imdsv2_is_enforced" {
  command = apply

  assert {
    condition = alltrue([
      for lt in concat([aws_launch_template.control_plane], values(aws_launch_template.agent)) :
      alltrue([for b in lt.block_device_mappings : alltrue([for e in b.ebs : e.encrypted == "true" && e.volume_type == "gp3" && e.kms_key_id == aws_kms_key.nodes.arn])])
    ])
    error_message = "Every node root volume must be gp3, encrypted with the module's KMS key."
  }

  assert {
    condition = alltrue([
      for lt in concat([aws_launch_template.control_plane], values(aws_launch_template.agent)) :
      lt.metadata_options[0].http_tokens == "required" && lt.metadata_options[0].http_put_response_hop_limit == 1
    ])
    error_message = "Every launch template must enforce IMDSv2 with hop limit 1 (INFRA-003)."
  }

  assert {
    condition     = aws_kms_key.nodes.enable_key_rotation == true
    error_message = "The node KMS key must rotate."
  }

  assert {
    condition     = strcontains(aws_kms_key.nodes.policy, "AWSServiceRoleForAutoScaling") && strcontains(aws_kms_key.nodes.policy, "kms:GrantIsForAWSResource")
    error_message = "The ASG service-linked role must be able to use the key, or encrypted instances never launch."
  }
}

run "rejects_weakened_metadata_options" {
  command = plan

  variables {
    metadata_options = {
      http_endpoint               = "enabled"
      http_tokens                 = "optional"
      http_put_response_hop_limit = 2
      instance_metadata_tags      = "disabled"
    }
  }

  expect_failures = [var.metadata_options]
}

run "pools_are_placed_in_their_subnet_tiers" {
  command = apply

  assert {
    condition     = toset(aws_autoscaling_group.pool["sandbox"].vpc_zone_identifier) == toset(["subnet-sbx-a", "subnet-sbx-b"])
    error_message = "Sandbox agents must be in the isolated sandbox subnets."
  }

  assert {
    condition     = toset(aws_autoscaling_group.pool["control-plane"].vpc_zone_identifier) == toset(["subnet-app-a", "subnet-app-b"]) && toset(aws_autoscaling_group.pool["egress"].vpc_zone_identifier) == toset(["subnet-app-a", "subnet-app-b"])
    error_message = "Control plane and egress nodes must be in the private-app subnets."
  }

  assert {
    condition     = aws_lb.api.internal == true && toset(aws_lb.api.subnets) == toset(["subnet-app-a", "subnet-app-b"]) && aws_lb.api.enable_cross_zone_load_balancing == true
    error_message = "The API load balancer must be internal (never public), in private-app, cross-zone so every AZ reaches the single server."
  }

  assert {
    condition     = toset(aws_vpc_endpoint.interface["ssm"].subnet_ids) == toset(["subnet-sbx-a", "subnet-sbx-b"]) && aws_vpc_endpoint.interface["logs"].private_dns_enabled == true
    error_message = "SSM and Logs endpoints must sit in the sandbox subnets with private DNS so air-gapped nodes reach them."
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.sandbox_to_api_lb.referenced_security_group_id == "sg-api-lb" && aws_vpc_security_group_egress_rule.sandbox_to_api_lb.from_port == 6443
    error_message = "Sandbox nodes join the API server over the VPC-internal LB route only."
  }

  assert {
    condition     = alltrue([for r in aws_vpc_security_group_ingress_rule.api_lb_from_nodes : r.cidr_ipv4 == null && r.referenced_security_group_id != null])
    error_message = "The API LB accepts security groups only, never a CIDR."
  }
}

run "fixed_size_pools_single_control_plane_and_rolling_replacement" {
  command = apply

  variables {
    node_pools = { sandbox = { count = 3 }, egress = { count = 2 } }
  }

  assert {
    condition     = aws_autoscaling_group.pool["control-plane"].min_size == 1 && aws_autoscaling_group.pool["control-plane"].max_size == 1 && aws_autoscaling_group.pool["sandbox"].min_size == 3 && aws_autoscaling_group.pool["sandbox"].max_size == 3 && aws_autoscaling_group.pool["egress"].desired_capacity == 2
    error_message = "Pools are fixed size in v1 and the control plane is exactly one node."
  }

  assert {
    condition     = contains(aws_autoscaling_group.pool["control-plane"].suspended_processes, "AZRebalance") && length(aws_autoscaling_group.pool["sandbox"].suspended_processes) == 0
    error_message = "AZ rebalancing must never terminate the single control plane; agent pools rebalance across AZs."
  }

  assert {
    condition     = alltrue([for asg in aws_autoscaling_group.pool : asg.instance_refresh[0].strategy == "Rolling"])
    error_message = "A new launch template version must replace the nodes (rolling instance refresh) so they rejoin automatically."
  }

  assert {
    condition     = toset(aws_autoscaling_group.pool["control-plane"].target_group_arns) == toset([aws_lb_target_group.api.arn]) && length(aws_autoscaling_group.pool["egress"].target_group_arns) == 0
    error_message = "Only the control plane registers behind the API load balancer."
  }

  assert {
    condition     = strcontains(base64decode(aws_launch_template.agent["sandbox"].user_data), "BW_CONTROL_PLANE_GENERATION='7'")
    error_message = "Agent user-data must carry the control-plane generation so a new control plane rolls the agents."
  }
}

run "server_and_agent_k3s_configuration" {
  command = apply

  assert {
    condition = alltrue([
      for s in ["disable", "servicelb", "tls-san", "blackwing-test-k3s-api-0123456789abcdef.elb.eu-central-1.amazonaws.com", "write-kubeconfig-mode", "\"0600\"", "secrets-encryption", "agent-token-file", "BW_NODE_ROLE='server'", "system-reserved=cpu=250m,memory=512Mi"] :
      strcontains(base64decode(aws_launch_template.control_plane.user_data), s)
    ])
    error_message = "The server must disable servicelb (Traefik kept), carry the internal API DNS as TLS SAN, write a 0600 kubeconfig and reserve kubelet resources."
  }

  assert {
    condition = alltrue([
      for s in ["https://blackwing-test-k3s-api-0123456789abcdef.elb.eu-central-1.amazonaws.com:6443", "BW_NODE_ROLE='agent'", "BW_INSTALL_RUNSC='true'", "kube-reserved=cpu=500m,memory=1Gi", "BW_K3S_BASE_URL='https://blackwing-test-node-artifacts.s3.eu-central-1.amazonaws.com/k3s'"] :
      strcontains(base64decode(aws_launch_template.agent["sandbox"].user_data), s)
    ])
    error_message = "Sandbox agents join the internal API URL, install the gVisor prerequisites and download from the in-VPC mirror."
  }

  assert {
    condition     = strcontains(base64decode(aws_launch_template.agent["egress"].user_data), "BW_INSTALL_RUNSC='false'")
    error_message = "Only sandbox nodes install gVisor."
  }

  assert {
    condition     = aws_launch_template.control_plane.image_id == "ami-0fedcba9876543210" && output.node_ami_id == "ami-0fedcba9876543210"
    error_message = "With no pinned AMI the Canonical 24.04 AMI is resolved and recorded."
  }
}

run "agents_can_read_only_the_agent_token_and_server_version" {
  command = apply

  assert {
    condition = alltrue([
      for p in aws_iam_role_policy.agent_k3s :
      jsondecode(p.policy).Statement[0].Action == ["ssm:GetParameter"] &&
      jsondecode(p.policy).Statement[0].Resource == ["arn:aws:ssm:eu-central-1:123456789012:parameter/blackwing/dev/k3s/agent-token", "arn:aws:ssm:eu-central-1:123456789012:parameter/blackwing/dev/k3s/server-version"]
    ])
    error_message = "Agents may only read the agent token and the server version."
  }

  assert {
    condition     = alltrue([for p in aws_iam_role_policy.agent_k3s : !strcontains(p.policy, "join-token") && !strcontains(p.policy, "kubeconfig") && !strcontains(p.policy, "PutParameter")])
    error_message = "Agents must never read the server join token or the kubeconfig, nor write SSM."
  }

  assert {
    condition     = alltrue([for p in aws_iam_role_policy.agent_k3s : jsondecode(p.policy).Statement[1].Condition.StringEquals["kms:EncryptionContext:PARAMETER_ARN"] == "arn:aws:ssm:eu-central-1:123456789012:parameter/blackwing/dev/k3s/agent-token"])
    error_message = "Agent kms:Decrypt is limited to the agent-token parameter through SSM."
  }

  assert {
    condition     = aws_iam_role_policy.control_plane_k3s.role == "blackwing-test-control-plane-node" && jsondecode(aws_iam_role_policy.control_plane_k3s.policy).Statement[1].Condition.StringEquals["kms:ViaService"] == "ssm.eu-central-1.amazonaws.com"
    error_message = "The control plane uses the key only through SSM."
  }
}

run "rejects_floating_k3s_versions" {
  command = plan

  variables {
    k3s_version = "v1.37.x+k3s1"
  }

  expect_failures = [var.k3s_version]
}

run "rejects_latest_k3s_channel" {
  command = plan

  variables {
    k3s_version = "latest"
  }

  expect_failures = [var.k3s_version]
}

run "sandbox_pool_without_an_in_vpc_mirror_is_refused" {
  command = plan

  variables {
    artifact_mirror_url = null
  }

  expect_failures = [aws_launch_template.agent]
}

run "without_a_sandbox_pool_upstream_downloads_are_allowed" {
  command = apply

  variables {
    artifact_mirror_url = null
    node_pools          = { sandbox = { count = 0 } }
  }

  assert {
    condition     = strcontains(base64decode(aws_launch_template.control_plane.user_data), "BW_K3S_BASE_URL='https://github.com/k3s-io/k3s/releases/download'")
    error_message = "Without a mirror, nodes with internet download from the upstream release."
  }
}
