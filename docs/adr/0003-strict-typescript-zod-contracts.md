# ADR-0003: Use strict TypeScript and shared Zod contracts at every boundary

Date: 2026-10-20

## Status

Accepted

## Context

Most of Blackwing's inputs are untrusted: HTTP requests, queue messages, environment variables, uploaded specs,
tool output from sandboxes and upstream APIs. Target content in particular is attacker-influenced data. The API,
console, worker, agent runtime and CLI exchange the same shapes, and a drift between a producer's and a
consumer's idea of a payload is both a bug and a security risk.

## Decision

- All services except the egress gateway are written in **TypeScript 5.x** on **Node.js 22 LTS**, ESM, with one
  strict base configuration: `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on.
  `any` is a lint error and non-null assertions are not allowed.
- **Every external input is parsed with Zod at the boundary** before it is used. Schemas shared between
  services live in `@blackwing/contracts`, which the API, console, worker, agent runtime and CLI all import.
- REST's OpenAPI 3.1 document is generated from those Zod schemas, not written by hand.
- Errors use a typed `AppError` hierarchy with stable `code`s, logs are structured pino JSON with redaction,
  IDs are UUIDv7 (with prefixed public IDs) and timestamps are ISO-8601 UTC.

## Consequences

- A contract change is a type error in every consumer until it is handled, and the API documentation cannot
  drift from the validation that actually runs.
- Data that fails validation is rejected at the edge, so the domain code only handles typed values.
- The strict flags make some code more verbose (explicit `undefined` handling, narrowing); that cost is
  accepted and is not relaxed per package.

## References

- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  rows "Languages" and "Contracts", and the TypeScript conventions under the table.
- [Context Pack §9 API conventions](../architecture/CONTEXT_PACK.md#9-api-conventions): every endpoint is in
  the OpenAPI spec.
- [Context Pack §4.5 Policy and terms constraints](../architecture/CONTEXT_PACK.md#45-policy--terms-constraints-must-follow):
  target content is untrusted data.
