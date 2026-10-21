# Tenant-onboarding / shred role (SECRETS-001, §8.6/§8.7/§8.8). Creates and configures tenant-* Transit
# keys and records their lifecycle state. Reading a non-exportable key returns metadata only (versions,
# type), never key material. No export, backup, datakey or delete; no encrypt/decrypt.
path "transit/keys/tenant-*" {
  capabilities = ["create", "update", "read"]
}
path "transit/keys/tenant-*/config" {
  capabilities = ["update"]
}
path "transit/keys/tenant-*/rotate" {
  capabilities = ["update"]
}
path "secret/data/platform/kek-state/*" {
  capabilities = ["create", "update", "read"]
}
