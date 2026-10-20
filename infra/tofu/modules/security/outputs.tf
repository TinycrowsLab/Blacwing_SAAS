output "security_group_ids" {
  description = "Security group IDs by node role (control-plane, sandbox, egress)."
  value = {
    control-plane = aws_security_group.control_plane.id
    sandbox       = aws_security_group.sandbox.id
    egress        = aws_security_group.egress.id
  }
}

output "instance_profile_names" {
  description = "Instance profile names by node role, for the launch templates (INFRA-004)."
  value       = { for role, profile in aws_iam_instance_profile.node : role => profile.name }
}

output "instance_profile_arns" {
  description = "Instance profile ARNs by node role."
  value       = { for role, profile in aws_iam_instance_profile.node : role => profile.arn }
}

output "iam_role_arns" {
  description = "IAM role ARNs by node role."
  value       = { for role, r in aws_iam_role.node : role => r.arn }
}

output "node_log_group_names" {
  description = "CloudWatch log group names by node role."
  value       = { for role, g in aws_cloudwatch_log_group.node : role => g.name }
}

output "metadata_options" {
  description = "IMDS settings every node launch template MUST use: IMDSv2 required, hop limit 1."
  value       = local.metadata_options
}

output "iam_role_names" {
  description = "IAM role names by node role, for the policies the k3s module (INFRA-004) attaches."
  value       = { for role, r in aws_iam_role.node : role => r.name }
}
