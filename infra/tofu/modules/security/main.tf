# Per-node-role security groups, IAM roles / instance profiles and the IMDS hardening settings of
# the k3s node tiers (INFRA-003): control-plane, sandbox and egress.
#
# IMPORTANT (read before changing anything): security groups CANNOT block 169.254.169.254. The
# instance metadata service is link-local and traffic to it never passes a security group. The
# guarantee that a sandbox cannot obtain the node's credentials comes from two other layers:
#   1. IMDSv2 only with a hop limit of 1 (local.metadata_options, exported as `metadata_options`
#      and required on every launch template): the PUT token response carries TTL 1, so it dies
#      at the first routing hop, which is a container's virtual ethernet pair. Only the host
#      network namespace can complete the IMDSv2 handshake.
#   2. The Kubernetes NetworkPolicy that denies sandbox pods 169.254.169.254 (INFRA-011).
# Sandbox nodes additionally have an IAM role with no permission beyond ECR pull and log writes,
# so even a hypothetical leak yields nothing useful. Do not claim more than that.

locals {
  roles = toset(["control-plane", "sandbox", "egress"])

  # Single source of truth for IMDS settings. A constant, not a variable, so no caller can weaken it.
  metadata_options = {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  # Node-to-node ports (flannel VXLAN overlay, kubelet) used between the tiers.
  vxlan_port   = 8472
  kubelet_port = 10250

  has_ecr = length(var.ecr_repository_arns) > 0

  log_group_names = { for role in local.roles : role => "/blackwing/${var.name_prefix}/nodes/${role}" }

  # Every tier's SG, used to fan the overlay (VXLAN) rule out to all of them.
  all_sg_ids = {
    control-plane = aws_security_group.control_plane.id
    sandbox       = aws_security_group.sandbox.id
    egress        = aws_security_group.egress.id
  }
}

# ---------------------------------------------------------------------------------------------
# Security groups. Rules are separate resources so the groups can reference each other.
# ---------------------------------------------------------------------------------------------

resource "aws_security_group" "control_plane" {
  name        = "${var.name_prefix}-control-plane"
  description = "k3s control-plane nodes (INFRA-003)"
  vpc_id      = var.vpc_id

  tags = {
    Name     = "${var.name_prefix}-control-plane"
    NodeRole = "control-plane"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "sandbox" {
  name        = "${var.name_prefix}-sandbox-node"
  description = "gVisor sandbox nodes (INFRA-003): no inbound from the internet, egress only to the cluster and the egress gateway"
  vpc_id      = var.vpc_id

  tags = {
    Name     = "${var.name_prefix}-sandbox-node"
    NodeRole = "sandbox"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "egress" {
  name        = "${var.name_prefix}-egress-node"
  description = "Egress gateway nodes (INFRA-003): the only tier with internet egress"
  vpc_id      = var.vpc_id

  tags = {
    Name     = "${var.name_prefix}-egress-node"
    NodeRole = "egress"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- control-plane: ingress ---------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "cp_api_from_agents" {
  for_each = {
    sandbox = aws_security_group.sandbox.id
    egress  = aws_security_group.egress.id
  }

  security_group_id            = aws_security_group.control_plane.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = var.k3s_api_port
  to_port                      = var.k3s_api_port
  description                  = "k3s API from the ${each.key} agent SG"
}

resource "aws_vpc_security_group_ingress_rule" "cp_api_self" {
  security_group_id            = aws_security_group.control_plane.id
  referenced_security_group_id = aws_security_group.control_plane.id
  ip_protocol                  = "tcp"
  from_port                    = var.k3s_api_port
  to_port                      = var.k3s_api_port
  description                  = "k3s API between servers"
}

resource "aws_vpc_security_group_ingress_rule" "cp_etcd_self" {
  security_group_id            = aws_security_group.control_plane.id
  referenced_security_group_id = aws_security_group.control_plane.id
  ip_protocol                  = "tcp"
  from_port                    = 2379
  to_port                      = 2380
  description                  = "embedded etcd client and peer ports among servers"
}

resource "aws_vpc_security_group_ingress_rule" "cp_kubelet_self" {
  security_group_id            = aws_security_group.control_plane.id
  referenced_security_group_id = aws_security_group.control_plane.id
  ip_protocol                  = "tcp"
  from_port                    = local.kubelet_port
  to_port                      = local.kubelet_port
  description                  = "kubelet among servers"
}

resource "aws_vpc_security_group_ingress_rule" "cp_vxlan" {
  for_each = local.all_sg_ids

  security_group_id            = aws_security_group.control_plane.id
  referenced_security_group_id = each.value
  ip_protocol                  = "udp"
  from_port                    = local.vxlan_port
  to_port                      = local.vxlan_port
  description                  = "flannel VXLAN from the ${each.key} SG"
}

# The only path from outside: a load balancer SG, never a CIDR.
resource "aws_vpc_security_group_ingress_rule" "cp_from_lb" {
  count = var.lb_security_group_id == null ? 0 : 1

  security_group_id            = aws_security_group.control_plane.id
  referenced_security_group_id = var.lb_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = var.lb_target_port
  to_port                      = var.lb_target_port
  description                  = "ingress NodePort from the load balancer SG only"
}

# --- control-plane: egress ----------------------------------------------------------------

resource "aws_vpc_security_group_egress_rule" "cp_to_servers" {
  for_each = {
    api     = { protocol = "tcp", from = var.k3s_api_port, to = var.k3s_api_port }
    etcd    = { protocol = "tcp", from = 2379, to = 2380 }
    kubelet = { protocol = "tcp", from = local.kubelet_port, to = local.kubelet_port }
    vxlan   = { protocol = "udp", from = local.vxlan_port, to = local.vxlan_port }
  }

  security_group_id            = aws_security_group.control_plane.id
  referenced_security_group_id = aws_security_group.control_plane.id
  ip_protocol                  = each.value.protocol
  from_port                    = each.value.from
  to_port                      = each.value.to
  description                  = "${each.key} to other servers"
}

resource "aws_vpc_security_group_egress_rule" "cp_to_agents" {
  for_each = {
    for pair in setproduct(["sandbox", "egress"], ["kubelet", "vxlan"]) : "${pair[0]}-${pair[1]}" => {
      target   = pair[0] == "sandbox" ? aws_security_group.sandbox.id : aws_security_group.egress.id
      protocol = pair[1] == "kubelet" ? "tcp" : "udp"
      port     = pair[1] == "kubelet" ? local.kubelet_port : local.vxlan_port
    }
  }

  security_group_id            = aws_security_group.control_plane.id
  referenced_security_group_id = each.value.target
  ip_protocol                  = each.value.protocol
  from_port                    = each.value.port
  to_port                      = each.value.port
  description                  = "${each.key} to agents"
}

resource "aws_vpc_security_group_egress_rule" "cp_https_vpc" {
  security_group_id = aws_security_group.control_plane.id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to VPC interface endpoints (SSM, ECR, CloudWatch Logs)"
}

resource "aws_vpc_security_group_egress_rule" "cp_dns" {
  for_each = toset(["tcp", "udp"])

  security_group_id = aws_security_group.control_plane.id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = each.value
  from_port         = 53
  to_port           = 53
  description       = "DNS to the VPC resolver"
}

resource "aws_vpc_security_group_egress_rule" "cp_s3" {
  count = var.s3_prefix_list_id == null ? 0 : 1

  security_group_id = aws_security_group.control_plane.id
  prefix_list_id    = var.s3_prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to the S3 gateway endpoint (image layers)"
}

# --- sandbox nodes: ingress ---------------------------------------------------------------
# Nothing from the internet and nothing from any CIDR; only the cluster tiers by SG reference.

resource "aws_vpc_security_group_ingress_rule" "sandbox_kubelet" {
  security_group_id            = aws_security_group.sandbox.id
  referenced_security_group_id = aws_security_group.control_plane.id
  ip_protocol                  = "tcp"
  from_port                    = local.kubelet_port
  to_port                      = local.kubelet_port
  description                  = "kubelet from the control plane"
}

resource "aws_vpc_security_group_ingress_rule" "sandbox_vxlan" {
  for_each = local.all_sg_ids

  security_group_id            = aws_security_group.sandbox.id
  referenced_security_group_id = each.value
  ip_protocol                  = "udp"
  from_port                    = local.vxlan_port
  to_port                      = local.vxlan_port
  description                  = "flannel VXLAN from the ${each.key} SG"
}

# --- sandbox nodes: egress ----------------------------------------------------------------
# Deliberately NOT 0.0.0.0/0. Reaching 169.254.169.254 is not controlled here (see the header).

resource "aws_vpc_security_group_egress_rule" "sandbox_api" {
  security_group_id            = aws_security_group.sandbox.id
  referenced_security_group_id = aws_security_group.control_plane.id
  ip_protocol                  = "tcp"
  from_port                    = var.k3s_api_port
  to_port                      = var.k3s_api_port
  description                  = "k3s API on the control plane"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_to_egress_proxy" {
  security_group_id            = aws_security_group.sandbox.id
  referenced_security_group_id = aws_security_group.egress.id
  ip_protocol                  = "tcp"
  from_port                    = var.egress_proxy_port
  to_port                      = var.egress_proxy_port
  description                  = "egress gateway proxy: the only way out for sandbox traffic"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_vxlan" {
  for_each = local.all_sg_ids

  security_group_id            = aws_security_group.sandbox.id
  referenced_security_group_id = each.value
  ip_protocol                  = "udp"
  from_port                    = local.vxlan_port
  to_port                      = local.vxlan_port
  description                  = "flannel VXLAN to the ${each.key} SG"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_https_vpc" {
  security_group_id = aws_security_group.sandbox.id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to VPC interface endpoints (ECR, CloudWatch Logs)"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_dns" {
  for_each = toset(["tcp", "udp"])

  security_group_id = aws_security_group.sandbox.id
  cidr_ipv4         = var.vpc_cidr_block
  ip_protocol       = each.value
  from_port         = 53
  to_port           = 53
  description       = "DNS to the VPC resolver"
}

resource "aws_vpc_security_group_egress_rule" "sandbox_s3" {
  count = var.s3_prefix_list_id == null ? 0 : 1

  security_group_id = aws_security_group.sandbox.id
  prefix_list_id    = var.s3_prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to the S3 gateway endpoint (image layers)"
}

# --- egress nodes -------------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "egress_proxy_from_sandbox" {
  security_group_id            = aws_security_group.egress.id
  referenced_security_group_id = aws_security_group.sandbox.id
  ip_protocol                  = "tcp"
  from_port                    = var.egress_proxy_port
  to_port                      = var.egress_proxy_port
  description                  = "egress gateway proxy from sandbox nodes"
}

resource "aws_vpc_security_group_ingress_rule" "egress_kubelet" {
  security_group_id            = aws_security_group.egress.id
  referenced_security_group_id = aws_security_group.control_plane.id
  ip_protocol                  = "tcp"
  from_port                    = local.kubelet_port
  to_port                      = local.kubelet_port
  description                  = "kubelet from the control plane"
}

resource "aws_vpc_security_group_ingress_rule" "egress_vxlan" {
  for_each = local.all_sg_ids

  security_group_id            = aws_security_group.egress.id
  referenced_security_group_id = each.value
  ip_protocol                  = "udp"
  from_port                    = local.vxlan_port
  to_port                      = local.vxlan_port
  description                  = "flannel VXLAN from the ${each.key} SG"
}

# The only broad egress in the platform. What the gateway may actually reach is decided by its own
# envelope/policy enforcement (§8 #1, #2), not by this rule.
resource "aws_vpc_security_group_egress_rule" "egress_internet" {
  security_group_id = aws_security_group.egress.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "internet egress for the egress gateway tier (scoped by the gateway itself)"
}

# ---------------------------------------------------------------------------------------------
# Logs, IAM roles and instance profiles.
# ---------------------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "node" {
  for_each = local.roles

  name              = local.log_group_names[each.key]
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn

  tags = {
    Name     = "${var.name_prefix}-${each.key}-node-logs"
    NodeRole = each.key
  }
}

resource "aws_iam_role" "node" {
  for_each = local.roles

  name        = "${var.name_prefix}-${each.key}-node"
  description = "Instance role of the ${each.key} k3s nodes (INFRA-003)"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })

  tags = {
    Name     = "${var.name_prefix}-${each.key}-node"
    NodeRole = each.key
  }
}

resource "aws_iam_instance_profile" "node" {
  for_each = local.roles

  name = "${var.name_prefix}-${each.key}-node"
  role = aws_iam_role.node[each.key].name

  tags = {
    Name     = "${var.name_prefix}-${each.key}-node"
    NodeRole = each.key
  }
}

# CloudWatch Logs: write to the role's own log group only, never create groups or read others.
resource "aws_iam_role_policy" "logs" {
  for_each = local.roles

  name = "write-node-logs"
  role = aws_iam_role.node[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "WriteOwnNodeLogs"
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.node[each.key].arn}:*"
    }]
  })
}

# ECR pull. ecr:GetAuthorizationToken does not support resource-level permissions, so "*" is the
# only valid resource for that one action; the image-read actions are pinned to explicit ARNs.
resource "aws_iam_role_policy" "ecr_pull" {
  for_each = local.roles

  name = "ecr-pull"
  role = aws_iam_role.node[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "EcrAuthToken"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      }],
      local.has_ecr ? [{
        Sid      = "EcrPullExplicitRepositories"
        Effect   = "Allow"
        Action   = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]
        Resource = var.ecr_repository_arns
      }] : []
    )
  })
}

# Only the control plane reads the join token. Sandbox and egress nodes never hold SSM permissions.
resource "aws_iam_role_policy" "join_token" {
  name = "read-k3s-join-token"
  role = aws_iam_role.node["control-plane"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Sid      = "ReadK3sJoinToken"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = var.join_token_parameter_arns
      }],
      var.join_token_kms_key_arn == null ? [] : [{
        Sid      = "DecryptK3sJoinToken"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.join_token_kms_key_arn]
      }]
    )
  })
}

# ---------------------------------------------------------------------------------------------
# AWS Config rules (observability). They need a configuration recorder, hence opt-in.
# ---------------------------------------------------------------------------------------------

resource "aws_config_config_rule" "imdsv2_required" {
  count = var.enable_config_rules ? 1 : 0

  name        = "${var.name_prefix}-ec2-imdsv2-required"
  description = "EC2 instances must require IMDSv2 (INFRA-003)"

  source {
    owner             = "AWS"
    source_identifier = "EC2_IMDSV2_CHECK"
  }

  tags = {
    Name = "${var.name_prefix}-ec2-imdsv2-required"
  }
}

resource "aws_config_config_rule" "no_open_ssh" {
  count = var.enable_config_rules ? 1 : 0

  name        = "${var.name_prefix}-no-open-ssh"
  description = "Security groups must not allow 0.0.0.0/0 ingress on SSH (INFRA-003)"

  source {
    owner             = "AWS"
    source_identifier = "INCOMING_SSH_DISABLED"
  }

  tags = {
    Name = "${var.name_prefix}-no-open-ssh"
  }
}
