# k3s cluster on EC2 (INFRA-004): one control-plane server and the sandbox / egress agent pools,
# each a fixed-size Auto Scaling group over a launch template whose cloud-init installs the pinned
# k3s release and joins the node by itself. Read README.md before changing anything.
#
# OFFLINE-STUB(online-porting #890): validated offline only (mocked provider + bootstrap harness); the apply, terratest and pool smoke run on AWS are deferred to M10.
#
# Secrets: no token is ever in tofu state, user-data or the repo. The SSM parameters are created
# with a placeholder; the control plane generates the tokens on its first boot, writes them to SSM
# (SecureString, this module's KMS key) and later servers reuse them. Agents read only the
# agent-only token at boot.

locals {
  pools = toset(["control-plane", "sandbox", "egress"])

  # Where each pool lives (INFRA-002): sandbox agents in the isolated sandbox subnets, the rest in
  # private-app. Sizes are fixed in v1; the control plane is one node.
  pool_subnets = {
    control-plane = var.private_app_subnet_ids
    sandbox       = var.sandbox_subnet_ids
    egress        = var.private_app_subnet_ids
  }
  pool_size = {
    control-plane = 1
    sandbox       = var.node_pools.sandbox.count
    egress        = var.node_pools.egress.count
  }

  ssm_prefix = "/blackwing/${var.environment}/k3s"
  ssm_names = {
    join_token     = "${local.ssm_prefix}/join-token"
    agent_token    = "${local.ssm_prefix}/agent-token"
    kubeconfig     = "${local.ssm_prefix}/kubeconfig"
    server_version = "${local.ssm_prefix}/server-version"
  }
  ssm_arns = { for k, n in local.ssm_names : k => "arn:${var.partition}:ssm:${var.aws_region}:${var.aws_account_id}:parameter${n}" }

  # Non-secret placeholder the control plane replaces on first boot (it never leaves "pending" in a
  # usable cluster; the bootstrap treats it as "no token yet").
  token_placeholder = "pending"

  ami_id = var.ami_id != null ? var.ami_id : nonsensitive(data.aws_ssm_parameter.ubuntu_ami[0].insecure_value)

  api_host = aws_lb.api.dns_name
  api_url  = "https://${local.api_host}:${var.api_port}"

  upstream_k3s_base   = "https://github.com/k3s-io/k3s/releases/download"
  upstream_runsc_base = "https://storage.googleapis.com/gvisor/releases/release"
  k3s_base            = var.artifact_mirror_url == null ? local.upstream_k3s_base : "${var.artifact_mirror_url}/k3s"
  runsc_base          = var.artifact_mirror_url == null ? local.upstream_runsc_base : "${var.artifact_mirror_url}/gvisor"

  bootstrap_script = "${path.module}/files/bw-k3s-bootstrap.sh"

  kubelet_args = {
    for pool in local.pools : pool => [
      "system-reserved=cpu=${var.node_pools[pool].system_cpu},memory=${var.node_pools[pool].system_memory}",
      "kube-reserved=cpu=${var.node_pools[pool].kube_cpu},memory=${var.node_pools[pool].kube_memory}",
      "eviction-hard=${var.node_pools[pool].eviction_hard}",
    ]
  }

  node_labels = { for pool in local.pools : pool => ["blackwing.io/pool=${pool}"] }

  # Non-secret bootstrap settings, rendered to /etc/blackwing/k3s-node.env.
  node_env = {
    for pool in local.pools : pool => {
      BW_NODE_ROLE            = pool == "control-plane" ? "server" : "agent"
      BW_POOL                 = pool
      BW_K3S_VERSION          = var.k3s_version
      BW_K3S_SHA256           = var.k3s_sha256
      BW_K3S_AIRGAP_SHA256    = var.k3s_airgap_images_sha256
      BW_K3S_BASE_URL         = local.k3s_base
      BW_INSTALL_RUNSC        = pool == "sandbox" ? "true" : "false"
      BW_RUNSC_VERSION        = var.runsc_version
      BW_RUNSC_SHA512         = var.runsc_sha512
      BW_RUNSC_BASE_URL       = local.runsc_base
      BW_AWS_REGION           = var.aws_region
      BW_KMS_KEY_ARN          = aws_kms_key.nodes.arn
      BW_SSM_JOIN_TOKEN       = local.ssm_names.join_token
      BW_SSM_AGENT_TOKEN      = local.ssm_names.agent_token
      BW_SSM_KUBECONFIG       = local.ssm_names.kubeconfig
      BW_SSM_SERVER_VERSION   = local.ssm_names.server_version
      BW_TOKEN_PLACEHOLDER    = local.token_placeholder
      BW_API_HOST             = local.api_host
      BW_API_PORT             = tostring(var.api_port)
      BW_LOG_GROUP            = var.log_group_names[pool]
      BW_MAX_ATTEMPTS         = tostring(var.bootstrap_max_attempts)
      BW_BACKOFF_BASE_SECONDS = "2"
      BW_BACKOFF_MAX_SECONDS  = "60"
    }
  }

  # k3s config.yaml per pool (no secrets: tokens are files the bootstrap writes from SSM).
  k3s_server_config = {
    "write-kubeconfig-mode" = "0600"
    "tls-san"               = [local.api_host]
    "https-listen-port"     = var.api_port
    "disable"               = ["servicelb"] # Traefik stays (CONTEXT_PACK §5); AWS load balancers replace servicelb.
    "secrets-encryption"    = true
    "token-file"            = "/etc/rancher/k3s/server-token"
    "agent-token-file"      = "/etc/rancher/k3s/agent-token"
    "node-label"            = local.node_labels["control-plane"]
    "kubelet-arg"           = local.kubelet_args["control-plane"]
  }
  k3s_agent_config = {
    for pool in ["sandbox", "egress"] : pool => {
      "server"      = local.api_url
      "token-file"  = "/etc/rancher/k3s/agent-token"
      "node-label"  = local.node_labels[pool]
      "kubelet-arg" = local.kubelet_args[pool]
    }
  }

  cloud_init_template = "${path.module}/templates/cloud-init.yaml.tftpl"
  bootstrap_b64gz     = base64gzip(file(local.bootstrap_script))

  server_cloud_init = templatefile(local.cloud_init_template, {
    env    = local.node_env["control-plane"]
    config = local.k3s_server_config
    script = local.bootstrap_b64gz
  })

  node_tags = {
    for pool in local.pools : pool => merge(data.aws_default_tags.current.tags, {
      Name                = "${var.name_prefix}-k3s-${pool}"
      NodeRole            = pool
      "blackwing.io/pool" = pool
      "blackwing.io/k3s"  = var.k3s_version
      "blackwing.io/ami"  = local.ami_id
    })
  }
}

# Provider default_tags do not reach instances and volumes launched by an ASG; copy them in.
data "aws_default_tags" "current" {}

data "aws_ssm_parameter" "ubuntu_ami" {
  count = var.ami_id == null ? 1 : 0
  name  = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}


# ---------------------------------------------------------------------------------------------
# KMS key for node root volumes and the k3s SSM SecureStrings.
# ---------------------------------------------------------------------------------------------

resource "aws_kms_key" "nodes" {
  description             = "${var.name_prefix} k3s node volumes and join-token parameters"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:${var.partition}:iam::${var.aws_account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        # The ASG launches the instances, so its service-linked role must be able to use the key
        # for the encrypted root volumes.
        Sid       = "AutoScalingVolumes"
        Effect    = "Allow"
        Principal = { AWS = "arn:${var.partition}:iam::${var.aws_account_id}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
      },
      {
        Sid       = "AutoScalingVolumeGrants"
        Effect    = "Allow"
        Principal = { AWS = "arn:${var.partition}:iam::${var.aws_account_id}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling" }
        Action    = "kms:CreateGrant"
        Resource  = "*"
        Condition = { Bool = { "kms:GrantIsForAWSResource" = "true" } }
      },
    ]
  })
}

resource "aws_kms_alias" "nodes" {
  name          = "alias/${var.name_prefix}-k3s-nodes"
  target_key_id = aws_kms_key.nodes.key_id
}

# ---------------------------------------------------------------------------------------------
# SSM parameters. Values are placeholders owned by the control plane after first boot.
# ---------------------------------------------------------------------------------------------

resource "aws_ssm_parameter" "secure" {
  for_each = {
    join_token  = { description = "k3s server join token (control plane only)", tier = "Standard" }
    agent_token = { description = "k3s agent-only join token (agents)", tier = "Standard" }
    kubeconfig  = { description = "k3s admin kubeconfig for CI/ops (internal API endpoint)", tier = "Advanced" }
  }

  name        = local.ssm_names[each.key]
  description = each.value.description
  type        = "SecureString"
  tier        = each.value.tier
  key_id      = aws_kms_key.nodes.arn
  value       = local.token_placeholder

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "server_version" {
  name        = local.ssm_names.server_version
  description = "k3s version the running control plane reports; agents refuse to join on mismatch"
  type        = "String"
  value       = local.token_placeholder

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_iam_role_policy" "control_plane_k3s" {
  name = "k3s-bootstrap"
  role = var.iam_role_names["control-plane"]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "K3sParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:PutParameter"]
        Resource = values(local.ssm_arns)
      },
      {
        Sid      = "K3sParameterKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.nodes.arn]
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com" }
        }
      },
    ]
  })
}

# Agents: read-only, and only the agent token plus the published server version.
resource "aws_iam_role_policy" "agent_k3s" {
  for_each = toset(["sandbox", "egress"])

  name = "k3s-agent-join"
  role = var.iam_role_names[each.key]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadAgentJoinParameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = [local.ssm_arns.agent_token, local.ssm_arns.server_version]
      },
      {
        Sid      = "DecryptAgentTokenOnly"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.nodes.arn]
        Condition = {
          StringEquals = {
            "kms:ViaService"                      = "ssm.${var.aws_region}.amazonaws.com"
            "kms:EncryptionContext:PARAMETER_ARN" = local.ssm_arns.agent_token
          }
        }
      },
    ]
  })
}

# ---------------------------------------------------------------------------------------------
# Internal API load balancer: the stable server URL agents join through (never public).
# ---------------------------------------------------------------------------------------------

resource "aws_security_group" "api_lb" {
  name        = "${var.name_prefix}-k3s-api-lb"
  description = "Internal k3s API load balancer"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name_prefix}-k3s-api-lb" }
}

resource "aws_vpc_security_group_ingress_rule" "api_lb_from_nodes" {
  for_each = merge(
    { for role, id in var.security_group_ids : role => id },
    { for i, id in var.api_client_security_group_ids : "client-${i}" => id },
  )

  security_group_id            = aws_security_group.api_lb.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  description                  = "k3s API from ${each.key}"
}

resource "aws_vpc_security_group_egress_rule" "api_lb_to_control_plane" {
  security_group_id            = aws_security_group.api_lb.id
  referenced_security_group_id = var.security_group_ids["control-plane"]
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  description                  = "k3s API and health checks to the control plane"
}

resource "aws_vpc_security_group_ingress_rule" "control_plane_from_api_lb" {
  security_group_id            = var.security_group_ids["control-plane"]
  referenced_security_group_id = aws_security_group.api_lb.id
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  description                  = "k3s API from the internal API load balancer"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_to_api_lb" {
  security_group_id            = var.security_group_ids["sandbox"]
  referenced_security_group_id = aws_security_group.api_lb.id
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  description                  = "k3s API through the internal load balancer (VPC-internal route)"
}

resource "aws_lb" "api" {
  name               = "${var.name_prefix}-k3s-api"
  internal           = true
  load_balancer_type = "network"
  subnets            = var.private_app_subnet_ids
  security_groups    = [aws_security_group.api_lb.id]

  # One control plane in one AZ; agents in every AZ reach it through their local LB node.
  enable_cross_zone_load_balancing = true
}

resource "aws_lb_target_group" "api" {
  name               = "${var.name_prefix}-k3s-api"
  port               = var.api_port
  protocol           = "TCP"
  vpc_id             = var.vpc_id
  target_type        = "instance"
  preserve_client_ip = "false"

  health_check {
    protocol            = "TCP"
    port                = "traffic-port"
    interval            = 10
    healthy_threshold   = 3
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "api" {
  load_balancer_arn = aws_lb.api.arn
  port              = var.api_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ---------------------------------------------------------------------------------------------
# Interface endpoints the air-gapped sandbox nodes need at boot (SSM for the token, Logs for the
# bootstrap log). ECR + S3 (image and artifact pulls) are created by the ECR mirror issue (#840).
# ---------------------------------------------------------------------------------------------

resource "aws_security_group" "endpoints" {
  count = var.create_interface_endpoints ? 1 : 0

  name        = "${var.name_prefix}-k3s-endpoints"
  description = "SSM and CloudWatch Logs interface endpoints for the k3s nodes"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name_prefix}-k3s-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  count = var.create_interface_endpoints ? 1 : 0

  security_group_id = aws_security_group.endpoints[0].id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS from inside the VPC"
}

resource "aws_vpc_endpoint" "interface" {
  for_each = var.create_interface_endpoints ? toset(["ssm", "logs"]) : toset([])

  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.sandbox_subnet_ids
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true
  tags                = { Name = "${var.name_prefix}-${each.key}" }
}

# ---------------------------------------------------------------------------------------------
# Launch templates and Auto Scaling groups.
# ---------------------------------------------------------------------------------------------

resource "aws_launch_template" "control_plane" {
  name                   = "${var.name_prefix}-k3s-control-plane"
  image_id               = local.ami_id
  instance_type          = var.node_pools.control-plane.instance_type
  update_default_version = true
  ebs_optimized          = true
  user_data              = base64encode(local.server_cloud_init)
  vpc_security_group_ids = [var.security_group_ids["control-plane"]]

  iam_instance_profile {
    name = var.instance_profile_names["control-plane"]
  }

  metadata_options {
    http_endpoint               = var.metadata_options.http_endpoint
    http_tokens                 = var.metadata_options.http_tokens
    http_put_response_hop_limit = var.metadata_options.http_put_response_hop_limit
    instance_metadata_tags      = var.metadata_options.instance_metadata_tags
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type           = "gp3"
      volume_size           = var.node_pools.control-plane.root_volume_gb
      encrypted             = true
      kms_key_id            = aws_kms_key.nodes.arn
      delete_on_termination = true
    }
  }

  monitoring {
    enabled = true
  }

  dynamic "tag_specifications" {
    for_each = toset(["instance", "volume"])
    content {
      resource_type = tag_specifications.value
      tags          = local.node_tags["control-plane"]
    }
  }
}

# Agent cloud-init carries the control-plane generation: a new control plane (new CA) rolls the
# agent pools too, so every agent rejoins the new server instead of trusting a stale CA.
locals {
  agent_cloud_init = {
    for pool in ["sandbox", "egress"] : pool => templatefile(local.cloud_init_template, {
      env    = merge(local.node_env[pool], { BW_CONTROL_PLANE_GENERATION = tostring(aws_launch_template.control_plane.latest_version) })
      config = local.k3s_agent_config[pool]
      script = local.bootstrap_b64gz
    })
  }
}

resource "aws_launch_template" "agent" {
  for_each = toset(["sandbox", "egress"])

  name                   = "${var.name_prefix}-k3s-${each.key}"
  image_id               = local.ami_id
  instance_type          = var.node_pools[each.key].instance_type
  update_default_version = true
  ebs_optimized          = true
  user_data              = base64encode(local.agent_cloud_init[each.key])
  vpc_security_group_ids = [var.security_group_ids[each.key]]

  iam_instance_profile {
    name = var.instance_profile_names[each.key]
  }

  metadata_options {
    http_endpoint               = var.metadata_options.http_endpoint
    http_tokens                 = var.metadata_options.http_tokens
    http_put_response_hop_limit = var.metadata_options.http_put_response_hop_limit
    instance_metadata_tags      = var.metadata_options.instance_metadata_tags
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type           = "gp3"
      volume_size           = var.node_pools[each.key].root_volume_gb
      encrypted             = true
      kms_key_id            = aws_kms_key.nodes.arn
      delete_on_termination = true
    }
  }

  monitoring {
    enabled = true
  }

  dynamic "tag_specifications" {
    for_each = toset(["instance", "volume"])
    content {
      resource_type = tag_specifications.value
      tags          = local.node_tags[each.key]
    }
  }

  lifecycle {
    precondition {
      condition     = each.key != "sandbox" || var.node_pools.sandbox.count == 0 || var.artifact_mirror_url != null
      error_message = "The sandbox pool has no internet: set artifact_mirror_url to the in-VPC artifact mirror or its nodes can never install k3s."
    }
  }
}

locals {
  launch_templates = {
    control-plane = { id = aws_launch_template.control_plane.id, version = aws_launch_template.control_plane.latest_version }
    sandbox       = { id = aws_launch_template.agent["sandbox"].id, version = aws_launch_template.agent["sandbox"].latest_version }
    egress        = { id = aws_launch_template.agent["egress"].id, version = aws_launch_template.agent["egress"].latest_version }
  }
}

resource "aws_autoscaling_group" "pool" {
  for_each = local.pools

  name                      = "${var.name_prefix}-k3s-${each.key}"
  min_size                  = local.pool_size[each.key]
  max_size                  = local.pool_size[each.key]
  desired_capacity          = local.pool_size[each.key]
  vpc_zone_identifier       = local.pool_subnets[each.key]
  health_check_type         = "EC2"
  health_check_grace_period = 600
  target_group_arns         = each.key == "control-plane" ? [aws_lb_target_group.api.arn] : []

  # A single control plane must never be terminated just to rebalance AZs (documented SPOF).
  suspended_processes = each.key == "control-plane" ? ["AZRebalance"] : []

  launch_template {
    id      = local.launch_templates[each.key].id
    version = local.launch_templates[each.key].version
  }

  # A new launch template version (new k3s_version, AMI, user-data) replaces the nodes on apply;
  # each replacement bootstraps and rejoins by itself.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = each.key == "control-plane" ? 0 : 50
      instance_warmup        = 300
    }
  }

  dynamic "tag" {
    for_each = local.node_tags[each.key]
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = false
    }
  }
}
