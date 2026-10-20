# ADR-0004: Serve the control-plane API with NestJS on Fastify, REST for writes and GraphQL for reads

Date: 2026-10-20

## Status

Accepted

## Context

The control-plane API serves three kinds of clients: the web console (through its BFF), service accounts and
CI pipelines with scoped tokens, and the sandboxes' tool backends. It holds many modules (authorisations,
scoping, test plans, triage, reporting, connectors) that need consistent authentication, authorisation,
validation and error handling. The console's dashboards need flexible, aggregated reads, while state changes
must stay explicit, idempotent and auditable.

## Decision

- `apps/api` is a **NestJS 11** application on the **Fastify** adapter.
- **REST under `/v1`** is the primary interface and carries every mutation. Its OpenAPI 3.1 document is
  generated from the Zod contracts ([ADR-0003](0003-strict-typescript-zod-contracts.md)).
- **GraphQL under `/graphql`** (`@nestjs/graphql`, code-first, Mercurius) is read-focused, for console and
  dashboard queries. Mutations stay REST.
- The internal **Run Broker API** (`/internal/broker/*`) lives in the same application, is reachable only from
  the sandbox network and accepts only run-scoped tokens.
- Conventions are uniform: JSON camelCase, RFC 9457 problem+json errors with stable codes, cursor pagination,
  `Idempotency-Key` on creating POSTs, ETag/`If-Match` concurrency, per-token rate limits, and RBAC plus a
  Cedar resource check on every request.

## Consequences

- Writes have a single, audited path, so gates, separation of duties and idempotency are enforced in one place.
- GraphQL needs depth and complexity limits, DataLoader batching and persisted queries in production so a read
  API cannot become a denial-of-service vector.
- NestJS modules give each domain area its own boundary inside one deployable; splitting a module into its own
  service later is possible without changing the public contract.

## References

- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  row "API".
- [Context Pack §3.1 Layers](../architecture/CONTEXT_PACK.md#31-layers-from-the-component-diagram-and-where-each-lives):
  Access layer, "REST and GraphQL API".
- [Context Pack §9 API conventions](../architecture/CONTEXT_PACK.md#9-api-conventions).
- [Context Pack §6 Repository layout](../architecture/CONTEXT_PACK.md#6-repository-layout-create-exactly-this):
  `apps/api`.
