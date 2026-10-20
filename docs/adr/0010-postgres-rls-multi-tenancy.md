# ADR-0010: Make the SaaS multi-tenant with Postgres row-level security as the isolation backbone

Date: 2026-10-20

## Status

Accepted

## Context

The original feature list ruled multi-tenancy out of v1. The SaaS edition reverses that: organisations are
tenants of one Blackwing-operated platform, and a leak of one customer's assets, findings or evidence to
another is the worst failure the product can have. Application-level `WHERE tenant_id = …` filters alone are one
forgotten clause away from such a leak.

## Decision

- Blackwing is **multi-tenant**; an organisation is a tenant. Every tenant table in **PostgreSQL 16** carries
  `tenant_id uuid not null` and has **row-level security** with the policy
  `USING (tenant_id = current_setting('app.tenant_id')::uuid)`.
- The application's database role has no `BYPASSRLS`; migrations run as a separate owner role.
- Every request runs its queries inside a transaction that sets the tenant with `SET LOCAL app.tenant_id`
  (`withTenant`). **A request without a tenant context fails closed.**
- The same isolation applies to every other store: a mandatory `tenantId` guard in the Neo4j repository layer,
  S3 prefixes with a per-tenant encryption context, Valkey key prefixes, per-run sandboxes and per-tenant memory
  with no cross-tenant retrieval.

## Consequences

- Isolation is enforced by the database even when application code is wrong, and cross-tenant access tests are
  mandatory for every data-access module.
- Connection pooling must never leak a tenant setting between requests, which `SET LOCAL` inside a transaction
  guarantees; code that queries outside `withTenant` gets no rows or an error, never another tenant's data.
- Platform-operator functions that legitimately span tenants need explicit, audited paths rather than a bypass
  role.

## References

- [Context Pack §1.1 Deliberate overrides](../architecture/CONTEXT_PACK.md#11-what-changed-versus-the-original-feature-list-deliberate-overrides):
  row "Multi-tenant platform: not in v1" (reversed).
- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  rows "DB" and "Graph".
- [Context Pack §7 Core domain model](../architecture/CONTEXT_PACK.md#7-core-domain-model-tables-in-packagesdb-all-tenant-tables-have-tenant_id-uuid-not-null--rls):
  the RLS rules.
- [Context Pack §8 Security invariants](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch):
  §8.6 (tenant isolation everywhere).
