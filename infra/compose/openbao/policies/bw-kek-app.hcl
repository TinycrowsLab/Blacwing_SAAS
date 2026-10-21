# Blackwing app role for per-tenant envelope encryption (SECRETS-001, §8.6/§8.7).
# Only encrypt / decrypt / rewrap / rotate on tenant-* Transit keys. No export, backup, key read,
# config or delete: key material never leaves OpenBao.
path "transit/encrypt/tenant-*" {
  capabilities = ["update"]
}
path "transit/decrypt/tenant-*" {
  capabilities = ["update"]
}
path "transit/rewrap/tenant-*" {
  capabilities = ["update"]
}
path "transit/keys/tenant-*/rotate" {
  capabilities = ["update"]
}
# Tenant lifecycle state (disabled marker) is readable so callers can fail closed.
path "secret/data/platform/kek-state/*" {
  capabilities = ["read"]
}
