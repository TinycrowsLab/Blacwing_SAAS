# Per-run MITM CA issuer (SANDBOX-008, §4.1/§8.7). The sandbox controller writes a run CA private key and
# its public certificate under the tenant's run path, reads them back for idempotent issuance, and deletes
# the key on run end or kill. Nothing else: no list, no transit, no other secret paths, and the sandbox
# never holds this role's token. `+` matches exactly one path segment (one tenant, one run).
path "secret/data/tenants/+/runs/+/run-ca/*" {
  capabilities = ["create", "update", "read"]
}
path "secret/metadata/tenants/+/runs/+/run-ca/*" {
  capabilities = ["delete"]
}
