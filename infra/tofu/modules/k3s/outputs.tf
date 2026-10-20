output "k3s_version" {
  description = "The k3s release pinned on every node (CONTEXT_PACK §8 #9); agents refuse to join a server reporting anything else."
  value       = var.k3s_version
}

output "node_ami_id" {
  description = "AMI every node launches from (also the blackwing.io/ami instance tag)."
  value       = local.ami_id
}

output "api_endpoint" {
  description = "Internal DNS name of the k3s API load balancer (in the API certificate's SANs). Never public."
  value       = local.api_host
}

output "api_url" {
  description = "k3s server URL the agents join and the exported kubeconfig points at."
  value       = local.api_url
}

output "api_lb_security_group_id" {
  description = "Security group of the internal API load balancer."
  value       = aws_security_group.api_lb.id
}

output "autoscaling_group_names" {
  description = "Auto Scaling group name by pool."
  value       = { for pool, asg in aws_autoscaling_group.pool : pool => asg.name }
}

output "launch_template_ids" {
  description = "Launch template ID by pool."
  value       = { for pool, lt in local.launch_templates : pool => lt.id }
}

output "pool_labels" {
  description = "Node label every node of a pool carries; use it as the nodeSelector."
  value       = { for pool in local.pools : pool => { "blackwing.io/pool" = pool } }
}

output "kms_key_arn" {
  description = "KMS key of the node root volumes and the k3s SecureString parameters."
  value       = aws_kms_key.nodes.arn
}

output "ssm_parameter_names" {
  description = "SSM parameter names: join_token (server, control plane only), agent_token, kubeconfig (ops/CI), server_version."
  value       = local.ssm_names
}

output "kubeconfig_parameter_arn" {
  description = "ARN of the SecureString holding the admin kubeconfig. Grant ssm:GetParameter on it to ops/CI roles only."
  value       = local.ssm_arns.kubeconfig
}
