# ADR-0009: Manage secrets with OpenBao envelope encryption and bring-your-own-key references

Date: 2026-10-20

## Status

Accepted

## Context

Blackwing holds highly sensitive material for many tenants: target credentials per role, connector tokens,
model provider keys, signing keys and evidence. The original feature list kept secrets in the customer's key
store for a single-tenant on-prem install. A multi-tenant SaaS needs per-tenant cryptographic isolation it
operates itself, while still letting customers keep keys or secrets in systems they control.

## Decision

- **OpenBao**, operated by Blackwing, is the secrets and key service: **Transit** for per-tenant envelope
  encryption and **KV v2** for platform secrets, accessed through `packages/secrets`.
- Customers can **bring their own key or vault by reference**: their AWS KMS key (cross-account), their
  HashiCorp Vault or OpenBao, AWS Secrets Manager or Azure Key Vault, each through a BYOK adapter.
- Secrets are stored and passed **by reference** (`secret_ref`), never as plaintext columns. The session manager
  and the egress gateway inject credentials at use; agents, the model and logs never see them, and known secret
  values are redacted from tool output and in the model gateway.

## Consequences

- A compromise of one tenant's data key does not expose another tenant's data, and BYOK customers can revoke
  Blackwing's access by revoking their key.
- Every component that needs a secret depends on OpenBao (or the BYOK adapter) being reachable; when it is not,
  the operation fails rather than falling back to a weaker store.
- BYOK adapters are an integration surface per provider, each with its own tests and failure handling.

## References

- [Context Pack §1.1 Deliberate overrides](../architecture/CONTEXT_PACK.md#11-what-changed-versus-the-original-feature-list-deliberate-overrides):
  row F35 "Secrets on customer key store".
- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  row "Secrets/KMS".
- [Context Pack §3.1 Layers](../architecture/CONTEXT_PACK.md#31-layers-from-the-component-diagram-and-where-each-lives):
  row "Secrets Service".
- [Context Pack §8 Security invariants](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch):
  §8.6 (per-tenant encryption context) and §8.7 (secrets never reach the model, the logs or the sandbox in
  plaintext).
