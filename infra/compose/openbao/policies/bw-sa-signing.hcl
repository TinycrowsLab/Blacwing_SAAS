# Standing-authorisation signing role (AUTHZ-004, #376, §8.7/§8.8).
# Only sign with, read the public keys of, and rotate the bw-sa-signing Ed25519 Transit key. No export,
# backup, delete or config: the private key never leaves OpenBao, and the key is created non-exportable.
path "transit/sign/bw-sa-signing" {
  capabilities = ["update"]
}
path "transit/keys/bw-sa-signing" {
  capabilities = ["read"]
}
path "transit/keys/bw-sa-signing/rotate" {
  capabilities = ["update"]
}
