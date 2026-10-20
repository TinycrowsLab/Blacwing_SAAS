# Offline tests for the vpc module (INFRA-002). The AWS provider is mocked: nothing here talks to
# AWS. Run with `tofu init -backend=false && tofu test` (infra/tofu/scripts/check.sh does both).

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["eu-central-1c", "eu-central-1a", "eu-central-1b"]
    }
  }

  # The provider validates ARN syntax, so mocked ARNs must look like ARNs.
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:eu-central-1:123456789012:log-group:/blackwing/blackwing-test/vpc-flow-logs"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/blackwing-test-vpc-flow-logs"
    }
  }
}

# Mocked IDs are identical across resources of one type, so give the route tables distinct IDs:
# otherwise "no route targets the sandbox table" could not tell the tables apart.
override_resource {
  target = aws_route_table.sandbox
  values = { id = "rtb-sandbox" }
}

override_resource {
  target = aws_route_table.public
  values = { id = "rtb-public" }
}

override_resource {
  target = aws_route_table.private_app
  values = { id = "rtb-private-app" }
}

variables {
  name_prefix = "blackwing-test"
  environment = "dev"
}

run "creates_vpc_igw_and_three_tiers_across_azs" {
  command = apply

  assert {
    condition     = aws_vpc.this.cidr_block == "10.40.0.0/16"
    error_message = "cidr_block must default to 10.40.0.0/16."
  }

  assert {
    condition     = aws_internet_gateway.this.vpc_id == aws_vpc.this.id
    error_message = "The Internet Gateway must be attached to the VPC."
  }

  assert {
    condition     = output.availability_zones == ["eu-central-1a", "eu-central-1b"]
    error_message = "With no explicit AZs, the first az_count available AZs (sorted) are used; default az_count is 2."
  }

  assert {
    condition = (
      length(aws_subnet.public) == 2 && length(aws_subnet.private_app) == 2 && length(aws_subnet.sandbox) == 2 &&
      length(distinct(aws_subnet.sandbox[*].availability_zone)) == 2 &&
      length(distinct(aws_subnet.private_app[*].availability_zone)) == 2 &&
      length(distinct(aws_subnet.public[*].availability_zone)) == 2
    )
    error_message = "Every tier needs one subnet in each of the 2 AZs."
  }

  assert {
    condition = (
      alltrue([for s in aws_subnet.public : s.tags["Tier"] == "public"]) &&
      alltrue([for s in aws_subnet.private_app : s.tags["Tier"] == "private-app"]) &&
      alltrue([for s in aws_subnet.sandbox : s.tags["Tier"] == "sandbox"])
    )
    error_message = "Subnets must carry Tier = public|private-app|sandbox."
  }

  assert {
    condition = length(distinct(flatten([
      aws_subnet.public[*].cidr_block, aws_subnet.private_app[*].cidr_block, aws_subnet.sandbox[*].cidr_block,
    ]))) == 6
    error_message = "Subnet CIDRs must be distinct."
  }

  assert {
    # Equal-size /20 blocks that are distinct and inside the VPC cannot overlap.
    condition = alltrue([
      for c in flatten(values(output.subnet_cidrs)) :
      endswith(c, "/20") && cidrhost("${cidrhost(c, 0)}/16", 0) == "10.40.0.0"
    ])
    error_message = "Every subnet must be a /20 inside the VPC CIDR."
  }

  assert {
    condition = alltrue([
      for s in concat(aws_subnet.public, aws_subnet.private_app, aws_subnet.sandbox) : s.map_public_ip_on_launch == false
    ])
    error_message = "No subnet may auto-assign public IPs (requirement 8)."
  }

  assert {
    condition     = length(aws_route_table_association.public) == 2 && length(aws_route_table_association.private_app) == 2 && length(aws_route_table_association.sandbox) == 2
    error_message = "Every subnet must be associated with its tier's route table."
  }
}

run "sandbox_route_table_has_no_default_internet_route" {
  command = apply

  # Regression guard for §8 #2: no 0.0.0.0/0 (or any other) route on the sandbox table.
  assert {
    condition     = length(aws_route_table.sandbox.route) == 0
    error_message = "The sandbox route table must have no routes besides the implicit local VPC route."
  }

  assert {
    condition = alltrue([
      for r in concat([aws_route.public_internet], aws_route.private_app_nat) : r.route_table_id != aws_route_table.sandbox.id
    ])
    error_message = "No aws_route may target the sandbox route table."
  }

  assert {
    condition     = alltrue([for a in aws_route_table_association.sandbox : a.route_table_id == aws_route_table.sandbox.id])
    error_message = "Sandbox subnets must use the sandbox route table."
  }

  assert {
    condition = (
      length(aws_network_acl.sandbox.egress) == 1 && length(aws_network_acl.sandbox.ingress) == 1 &&
      alltrue([for r in setunion(aws_network_acl.sandbox.egress, aws_network_acl.sandbox.ingress) : r.cidr_block == "10.40.0.0/16" && r.action == "allow"]) &&
      toset(aws_network_acl.sandbox.subnet_ids) == toset(aws_subnet.sandbox[*].id)
    )
    error_message = "The sandbox NACL must only allow the VPC CIDR and cover every sandbox subnet."
  }
}

run "public_routes_to_igw_and_private_app_routes_to_nat" {
  command = apply

  assert {
    condition = (
      aws_route.public_internet.destination_cidr_block == "0.0.0.0/0" &&
      aws_route.public_internet.gateway_id == aws_internet_gateway.this.id &&
      aws_route.public_internet.route_table_id == aws_route_table.public.id
    )
    error_message = "The public route table must send 0.0.0.0/0 to the Internet Gateway."
  }

  assert {
    condition = alltrue([
      for i, r in aws_route.private_app_nat :
      r.destination_cidr_block == "0.0.0.0/0" && r.nat_gateway_id == aws_nat_gateway.this[0].id &&
      r.route_table_id == aws_route_table.private_app[i].id
    ])
    error_message = "With a single NAT, every private-app route table must send 0.0.0.0/0 to it."
  }

  assert {
    condition     = alltrue([for n in aws_nat_gateway.this : contains(aws_subnet.public[*].id, n.subnet_id)])
    error_message = "NAT gateways must live in public subnets."
  }
}

run "egress_ips_equal_the_allocated_eip_set" {
  command = apply

  assert {
    condition     = length(aws_eip.nat) == 1 && output.single_nat == true
    error_message = "dev defaults to a single NAT with one EIP."
  }

  assert {
    condition     = output.egress_ips == aws_eip.nat[*].public_ip
    error_message = "egress_ips must equal the allocated EIP set."
  }

  assert {
    # Separate aws_eip resources referenced by allocation_id survive NAT gateway replacement.
    condition     = aws_nat_gateway.this[*].allocation_id == aws_eip.nat[*].allocation_id && output.egress_eip_allocation_ids == aws_eip.nat[*].allocation_id
    error_message = "Each NAT must use its own separately managed EIP."
  }

  assert {
    condition     = alltrue([for e in aws_eip.nat : e.domain == "vpc" && e.tags["Role"] == "customer-egress"])
    error_message = "Egress EIPs must be VPC EIPs tagged Role = customer-egress for dashboards."
  }
}

run "flow_logs_enabled_for_every_eni_with_action_fields" {
  command = apply

  assert {
    condition = (
      aws_flow_log.this.vpc_id == aws_vpc.this.id && aws_flow_log.this.traffic_type == "ALL" &&
      aws_flow_log.this.log_destination_type == "cloud-watch-logs" &&
      aws_flow_log.this.log_destination == aws_cloudwatch_log_group.flow_logs[0].arn &&
      aws_flow_log.this.iam_role_arn == aws_iam_role.flow_logs[0].arn
    )
    error_message = "A VPC-wide flow log (ALL traffic) must deliver to the CloudWatch log group."
  }

  assert {
    condition = alltrue([
      for f in ["$${action}", "$${srcaddr}", "$${dstaddr}", "$${bytes}", "$${subnet-id}"] : strcontains(aws_flow_log.this.log_format, f)
    ])
    error_message = "Flow log format must include action, srcaddr, dstaddr, bytes and subnet-id."
  }

  assert {
    condition     = aws_cloudwatch_log_group.flow_logs[0].retention_in_days == 365
    error_message = "Flow logs are kept 365 days by default."
  }

  assert {
    condition     = output.flow_log_id == aws_flow_log.this.id
    error_message = "flow_log_id output must expose the flow log."
  }
}

run "flow_logs_to_s3" {
  command = apply

  variables {
    flow_log_destination   = "s3"
    flow_log_s3_bucket_arn = "arn:aws:s3:::blackwing-test-logs/vpc"
  }

  assert {
    condition = (
      aws_flow_log.this.log_destination_type == "s3" &&
      aws_flow_log.this.log_destination == "arn:aws:s3:::blackwing-test-logs/vpc" &&
      length(aws_iam_role.flow_logs) == 0 && length(aws_cloudwatch_log_group.flow_logs) == 0
    )
    error_message = "S3 flow logs need no log group or delivery role."
  }
}

run "rejects_s3_flow_logs_without_bucket" {
  command = plan

  variables {
    flow_log_destination = "s3"
  }

  expect_failures = [aws_vpc.this]
}

# Edge case: AZ outage. prod spreads one NAT + distinct EIP per AZ, each AZ routing via its own NAT.
run "prod_uses_one_nat_and_distinct_eip_per_az" {
  command = apply

  variables {
    environment = "prod"
    az_count    = 3
  }

  assert {
    condition     = output.single_nat == false && length(aws_nat_gateway.this) == 3 && length(aws_eip.nat) == 3
    error_message = "prod must default to one NAT gateway per AZ."
  }

  assert {
    # One separately allocated EIP per NAT (the mock cannot produce distinct addresses).
    condition     = length(output.egress_ips) == 3 && output.egress_ips == aws_eip.nat[*].public_ip && length(distinct(aws_eip.nat[*].tags["Name"])) == 3
    error_message = "prod egress IPs must be one distinct EIP per NAT."
  }

  assert {
    condition = alltrue([
      for i, r in aws_route.private_app_nat : r.nat_gateway_id == aws_nat_gateway.this[i].id
    ])
    error_message = "Each private-app AZ must route through the NAT in its own AZ."
  }

  assert {
    condition = alltrue([
      for i, n in aws_nat_gateway.this : n.subnet_id == aws_subnet.public[i].id && n.tags["Name"] == "blackwing-test-nat-${output.availability_zones[i]}"
    ]) && length(distinct(aws_nat_gateway.this[*].tags["Name"])) == 3
    error_message = "Each NAT must sit in the public subnet of its own AZ."
  }

  assert {
    condition     = length(aws_route_table.sandbox.route) == 0
    error_message = "prod sandbox route table must have no routes either."
  }
}

# Edge case: single-NAT in prod is rejected.
run "rejects_single_nat_in_prod" {
  command = plan

  variables {
    environment = "prod"
    single_nat  = true
  }

  expect_failures = [aws_vpc.this]
}

run "staging_may_opt_into_per_az_nat" {
  command = plan

  variables {
    environment = "staging"
    single_nat  = false
  }

  assert {
    condition     = length(aws_nat_gateway.this) == 2 && length(aws_eip.nat) == 2
    error_message = "single_nat = false must create one NAT per AZ."
  }
}

# Edge case: EIP exhaustion fails with a clear message instead of a half-applied network.
run "rejects_more_nats_than_eip_quota" {
  command = plan

  variables {
    environment = "prod"
    az_count    = 4
    eip_quota   = 3
    availability_zones = [
      "eu-central-1a", "eu-central-1b", "eu-central-1c", "eu-central-1d",
    ]
  }

  expect_failures = [aws_vpc.this]
}

run "rejects_too_few_availability_zones" {
  command = plan

  variables {
    az_count           = 3
    availability_zones = ["eu-central-1a", "eu-central-1b"]
  }

  expect_failures = [aws_vpc.this]
}

run "rejects_single_az" {
  command = plan

  variables {
    az_count = 1
  }

  expect_failures = [var.az_count]
}

# Edge case: CIDR overlap with peered/customer networks. The CIDR is a variable; any RFC 1918 range
# works and the tier layout follows it.
run "custom_cidr_moves_every_tier" {
  command = apply

  variables {
    cidr_block         = "172.20.0.0/16"
    availability_zones = ["eu-west-1a", "eu-west-1b"]
  }

  assert {
    condition = (
      output.subnet_cidrs["public"] == ["172.20.0.0/20", "172.20.16.0/20"] &&
      output.subnet_cidrs["private-app"] == ["172.20.64.0/20", "172.20.80.0/20"] &&
      output.subnet_cidrs["sandbox"] == ["172.20.128.0/20", "172.20.144.0/20"]
    )
    error_message = "Tier subnets must be carved from cidr_block in fixed, non-overlapping blocks."
  }

  assert {
    condition     = output.availability_zones == ["eu-west-1a", "eu-west-1b"]
    error_message = "Explicit availability_zones must be used as given."
  }

  assert {
    condition     = alltrue([for r in setunion(aws_network_acl.sandbox.egress, aws_network_acl.sandbox.ingress) : r.cidr_block == "172.20.0.0/16"])
    error_message = "The sandbox NACL must follow cidr_block."
  }
}

run "rejects_public_cidr" {
  command = plan

  variables {
    cidr_block = "52.10.0.0/16"
  }

  expect_failures = [var.cidr_block]
}

run "rejects_cidr_with_host_bits" {
  command = plan

  variables {
    cidr_block = "10.40.1.0/16"
  }

  expect_failures = [var.cidr_block]
}

run "rejects_too_large_cidr" {
  command = plan

  variables {
    cidr_block = "10.0.0.0/8"
  }

  expect_failures = [var.cidr_block]
}

run "rejects_unknown_environment" {
  command = plan

  variables {
    environment = "qa"
  }

  expect_failures = [var.environment]
}
