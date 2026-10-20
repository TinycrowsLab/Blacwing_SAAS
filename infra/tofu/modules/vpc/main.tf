# vpc module (INFRA-002): the network backbone the egress fail-closed guarantee (§8 #2) depends on.
#
#   public       0.0.0.0/0 -> Internet Gateway. Hosts the NAT gateway(s) and the Traefik LB.
#   private-app  0.0.0.0/0 -> NAT gateway (static EIP). App nodes: package pulls, SES, model providers.
#   sandbox      NO default route, local VPC only (route table + NACL). The only way out is the
#                egress gateway inside the VPC, enforced by NetworkPolicy (INFRA-011).
#
# Never add an IGW or NAT route to the sandbox route table "for convenience": that silently breaks
# the core isolation invariant. tests/vpc.tftest.hcl asserts its absence.
#
# OFFLINE-STUB(online-porting #887): validated offline only (mocked provider); apply + sandbox egress integration check pending.

data "aws_availability_zones" "available" {
  count = length(var.availability_zones) == 0 ? 1 : 0
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs_all = length(var.availability_zones) > 0 ? var.availability_zones : sort(data.aws_availability_zones.available[0].names)
  # Too few AZs is reported by the aws_vpc precondition below, not by an index error.
  azs = [for i in range(var.az_count) : try(local.azs_all[i], "unavailable")]

  # null picks the environment default: shared NAT outside prod, one NAT per AZ in prod.
  single_nat = coalesce(var.single_nat, var.environment != "prod")
  nat_count  = local.single_nat ? 1 : var.az_count

  # Each subnet is 1/16 of the VPC. Tier blocks of 4 indices keep tiers contiguous and
  # non-overlapping for any az_count <= 4: public 0-3, private-app 4-7, sandbox 8-11, 12-15 spare.
  subnet_newbits = 4
  tier_offset = {
    public      = 0
    private-app = 4
    sandbox     = 8
  }
  subnet_cidrs = {
    for tier, offset in local.tier_offset :
    tier => [for i in range(var.az_count) : cidrsubnet(var.cidr_block, local.subnet_newbits, offset + i)]
  }

  flow_log_format = join(" ", [
    "$${version}", "$${account-id}", "$${interface-id}", "$${srcaddr}", "$${dstaddr}", "$${srcport}",
    "$${dstport}", "$${protocol}", "$${packets}", "$${bytes}", "$${start}", "$${end}", "$${action}",
    "$${log-status}", "$${vpc-id}", "$${subnet-id}", "$${instance-id}", "$${tcp-flags}",
    "$${pkt-srcaddr}", "$${pkt-dstaddr}", "$${flow-direction}",
  ])
  flow_logs_to_cloudwatch = var.flow_log_destination == "cloud-watch-logs"
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name_prefix}-vpc"
  }

  lifecycle {
    precondition {
      condition     = !(var.environment == "prod" && local.single_nat)
      error_message = "single_nat = true is not allowed in prod: prod needs one NAT gateway (and egress EIP) per AZ for HA."
    }
    precondition {
      condition     = length(local.azs_all) >= var.az_count
      error_message = "az_count = ${var.az_count} but only ${length(local.azs_all)} availability zone(s) are available: ${join(", ", local.azs_all)}."
    }
    precondition {
      condition     = local.nat_count <= var.eip_quota
      error_message = "The NAT gateways need ${local.nat_count} Elastic IP(s) but eip_quota is ${var.eip_quota}. Request an Elastic IP quota increase (Service Quotas: EC2 \"EC2-VPC Elastic IPs\", default 5 per region), then raise eip_quota."
    }
    precondition {
      condition     = var.flow_log_destination != "s3" || var.flow_log_s3_bucket_arn != null
      error_message = "flow_log_destination = \"s3\" requires flow_log_s3_bucket_arn."
    }
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-igw"
  }
}

# Lock down the default security group and NACL of the VPC: nothing may silently rely on them.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-default-deny"
  }
}

# ---------------------------------------------------------------------------------------- subnets

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = local.subnet_cidrs["public"][count.index]
  map_public_ip_on_launch = false # NAT uses its EIP and the LB its own; nothing needs auto-assign.

  tags = {
    Name = "${var.name_prefix}-public-${local.azs[count.index]}"
    Tier = "public"
  }
}

resource "aws_subnet" "private_app" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = local.subnet_cidrs["private-app"][count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name_prefix}-private-app-${local.azs[count.index]}"
    Tier = "private-app"
  }
}

resource "aws_subnet" "sandbox" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = local.subnet_cidrs["sandbox"][count.index]
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name_prefix}-sandbox-${local.azs[count.index]}"
    Tier = "sandbox"
  }
}

# ------------------------------------------------------------------------------- NAT and egress IPs

# The customer-facing egress addresses. Separate resources so they survive NAT gateway replacement;
# the allowlist customers keep (INFRA-015) stays valid across NAT recreation and AZ failover.
resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"

  tags = {
    Name    = "${var.name_prefix}-egress-${count.index}"
    Role    = "customer-egress"
    Purpose = "Blackwing static egress IP (customer allowlist)"
  }

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "this" {
  count = local.nat_count

  allocation_id = aws_eip.nat[count.index].allocation_id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name = "${var.name_prefix}-nat-${local.azs[count.index]}"
  }

  depends_on = [aws_internet_gateway.this]
}

# ---------------------------------------------------------------------------------- route tables

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-public"
    Tier = "public"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private_app" {
  count  = var.az_count
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name_prefix}-private-app-${local.azs[count.index]}"
    Tier = "private-app"
  }
}

resource "aws_route" "private_app_nat" {
  count = var.az_count

  route_table_id         = aws_route_table.private_app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[local.single_nat ? 0 : count.index].id
}

resource "aws_route_table_association" "private_app" {
  count = var.az_count

  subnet_id      = aws_subnet.private_app[count.index].id
  route_table_id = aws_route_table.private_app[count.index].id
}

# Sandbox: only the implicit local VPC route. `route = []` makes the table authoritative, so a
# route added out of band (console, CLI) is removed on the next apply instead of persisting.
resource "aws_route_table" "sandbox" {
  vpc_id = aws_vpc.this.id
  route  = []

  tags = {
    Name = "${var.name_prefix}-sandbox"
    Tier = "sandbox"
  }
}

resource "aws_route_table_association" "sandbox" {
  count = var.az_count

  subnet_id      = aws_subnet.sandbox[count.index].id
  route_table_id = aws_route_table.sandbox.id
}

# Second layer for the sandbox tier: a NACL that only admits traffic to and from the VPC CIDR, so
# even a route mistake cannot carry sandbox traffic to the internet.
resource "aws_network_acl" "sandbox" {
  vpc_id     = aws_vpc.this.id
  subnet_ids = aws_subnet.sandbox[*].id

  egress {
    rule_no    = 100
    protocol   = "-1"
    action     = "allow"
    cidr_block = var.cidr_block
    from_port  = 0
    to_port    = 0
  }

  ingress {
    rule_no    = 100
    protocol   = "-1"
    action     = "allow"
    cidr_block = var.cidr_block
    from_port  = 0
    to_port    = 0
  }

  tags = {
    Name = "${var.name_prefix}-sandbox"
    Tier = "sandbox"
  }
}

# --------------------------------------------------------------------------------------- flow logs

resource "aws_cloudwatch_log_group" "flow_logs" {
  count = local.flow_logs_to_cloudwatch ? 1 : 0

  name              = "/blackwing/${var.name_prefix}/vpc-flow-logs"
  retention_in_days = var.flow_log_retention_days
  kms_key_id        = var.flow_log_kms_key_arn
}

# Delivery role for CloudWatch flow logs: may only write to this module's log group.
resource "aws_iam_role" "flow_logs" {
  count = local.flow_logs_to_cloudwatch ? 1 : 0

  name = "${var.name_prefix}-vpc-flow-logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  count = local.flow_logs_to_cloudwatch ? 1 : 0

  name = "write-vpc-flow-logs"
  role = aws_iam_role.flow_logs[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
      Resource = "${aws_cloudwatch_log_group.flow_logs[0].arn}:*"
    }]
  })
}

# Attached to the VPC, so every ENI in every tier is covered; ALL logs ACCEPT and REJECT records.
resource "aws_flow_log" "this" {
  vpc_id                   = aws_vpc.this.id
  traffic_type             = "ALL"
  log_destination_type     = var.flow_log_destination
  log_destination          = local.flow_logs_to_cloudwatch ? aws_cloudwatch_log_group.flow_logs[0].arn : var.flow_log_s3_bucket_arn
  iam_role_arn             = local.flow_logs_to_cloudwatch ? aws_iam_role.flow_logs[0].arn : null
  log_format               = local.flow_log_format
  max_aggregation_interval = 60

  tags = {
    Name = "${var.name_prefix}-vpc-flow-logs"
  }
}
