output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "IPv4 CIDR of the VPC."
  value       = aws_vpc.this.cidr_block
}

output "availability_zones" {
  description = "AZs the tiers are spread across, in subnet index order."
  value       = local.azs
}

output "subnet_ids" {
  description = "Subnet IDs by tier (public, private-app, sandbox), in AZ order."
  value = {
    public      = aws_subnet.public[*].id
    private-app = aws_subnet.private_app[*].id
    sandbox     = aws_subnet.sandbox[*].id
  }
}

output "subnet_cidrs" {
  description = "Subnet CIDRs by tier, in AZ order."
  value       = local.subnet_cidrs
}

output "route_table_ids" {
  description = "Route table IDs by tier. private-app has one per AZ; sandbox has no default route."
  value = {
    public      = [aws_route_table.public.id]
    private-app = aws_route_table.private_app[*].id
    sandbox     = [aws_route_table.sandbox.id]
  }
}

output "nat_gateway_ids" {
  description = "NAT gateway IDs (one when single_nat, else one per AZ)."
  value       = aws_nat_gateway.this[*].id
}

output "egress_ips" {
  description = "The static egress EIPs: the set customers allowlist (published by INFRA-015)."
  value       = aws_eip.nat[*].public_ip
}

output "egress_eip_allocation_ids" {
  description = "Allocation IDs of the egress EIPs, in the same order as egress_ips."
  value       = aws_eip.nat[*].allocation_id
}

output "single_nat" {
  description = "Whether one NAT gateway is shared by every AZ (resolved from the single_nat input)."
  value       = local.single_nat
}

output "flow_log_id" {
  description = "ID of the VPC Flow Log covering every ENI of the VPC."
  value       = aws_flow_log.this.id
}
