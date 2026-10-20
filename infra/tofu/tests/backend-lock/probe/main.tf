# Lock probe for ../run.sh. Uses the real shared backend.tf and versions.tf (symlinks) and a
# single terraform_data resource whose apply holds the state lock for hold_seconds, so two
# concurrent applies can be raced against the DynamoDB lock. Talks to no AWS API.

variable "hold_seconds" {
  type    = number
  default = 0
}

variable "run_id" {
  type = string
}

resource "terraform_data" "hold" {
  input = var.run_id
  # Replace on every new run_id: the provisioner (the lock-holding sleep) only runs on create.
  triggers_replace = var.run_id

  provisioner "local-exec" {
    command = "sleep ${var.hold_seconds}"
  }
}

output "run_id" {
  value = terraform_data.hold.output
}
