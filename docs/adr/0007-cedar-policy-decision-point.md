# ADR-0007: Use Cedar as the policy decision point, shared between TypeScript and Go

Date: 2026-10-20

## Status

Accepted

## Context

Authorisation decisions are made in two languages and many places: API resource checks, the `PreToolUse` hook
that evaluates every Bash command and target-interaction tool call against the approved run envelope, and the
Go egress gateway that evaluates every outbound connection. Customers also own a policy layer of their own on
top of a platform baseline that they cannot override. If the TypeScript and Go sides evaluated policy
differently, an action denied in the agent runtime could still be allowed on the wire.

## Decision

- **Cedar** is the single policy language: `@cedar-policy/cedar-wasm` in TypeScript (`packages/policy`) and
  `github.com/cedar-policy/cedar-go` in the egress gateway.
- Both sides use **one shared Cedar schema and one shared set of test vectors**, so the two evaluators are
  proven to agree on every vector.
- The **platform baseline policy** is non-overridable: it hard-blocks the destructive intrusiveness class and
  anything else the platform forbids. Tenant policy sets are versioned (version, sha256, author) and cannot
  override the baseline.
- The policy hash is pinned per run. A failure to evaluate policy is a deny.

## Consequences

- One policy, two evaluators: any change to the schema or to the baseline must pass the shared vectors on
  both sides before it ships.
- Policy is data, not code, so customers can review and own their layer without code changes, and auditors can
  read the exact policy a run used.
- Model output never decides authorisation; the PDP does, deterministically.

## References

- [Context Pack §3.1 Layers](../architecture/CONTEXT_PACK.md#31-layers-from-the-component-diagram-and-where-each-lives):
  row "Policy Decision Point".
- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  row "Policy".
- [Context Pack §4.3 Mandatory SDK options](../architecture/CONTEXT_PACK.md#43-mandatory-sdk-options-for-every-blackwing-session-appsagent-runtimesrcsessionoptionsts):
  the `PreToolUse` policy check.
- [Context Pack §7 Core domain model](../architecture/CONTEXT_PACK.md#7-core-domain-model-tables-in-packagesdb-all-tenant-tables-have-tenant_id-uuid-not-null--rls):
  `policies` and the non-overridable baseline.
- [Context Pack §8 Security invariants](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch):
  §8.3 (destructive class never allowed), §8.9 (policy hash pinned) and §8.11 (deterministic enforcement).
