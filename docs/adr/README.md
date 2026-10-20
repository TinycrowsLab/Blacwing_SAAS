# Architecture decision records

This directory records Blackwing's architecture decisions, one decision per file. Each record restates a
decision fixed by the [Context Pack](../architecture/CONTEXT_PACK.md) and says why it was made; when a record and
the pack disagree, the pack wins. The process and format are decided in
[ADR-0001](0001-record-architecture-decisions.md).

## Index

| ADR | Decision | Status | Context Pack |
|---|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions as numbered, immutable ADRs | Accepted | §6, §10, §11 |
| [0002](0002-pnpm-turborepo-monorepo.md) | Build Blackwing from scratch in one pnpm and Turborepo monorepo | Accepted | §1.1, §5, §6 |
| [0003](0003-strict-typescript-zod-contracts.md) | Use strict TypeScript and shared Zod contracts at every boundary | Accepted | §4.5, §5, §9 |
| [0004](0004-nestjs-fastify-rest-graphql-api.md) | Serve the control-plane API with NestJS on Fastify, REST for writes and GraphQL for reads | Accepted | §3.1, §5, §6, §9 |
| [0005](0005-temporal-run-lifecycle.md) | Drive the run lifecycle with Temporal workflows (hybrid orchestration) | Accepted | §3.3, §4.2, §5, §8 |
| [0006](0006-claude-agent-sdk-claude-only-models.md) | Run the product's agents on the Claude Agent SDK with Claude models only | Accepted | §1.1, §4, §4.3, §4.5, §5, §8 |
| [0007](0007-cedar-policy-decision-point.md) | Use Cedar as the policy decision point, shared between TypeScript and Go | Accepted | §3.1, §4.3, §5, §7, §8 |
| [0008](0008-go-egress-gateway-fail-closed.md) | Route all target traffic through a fail-closed egress gateway written in Go | Accepted | §3.1, §4.1, §5, §8 |
| [0009](0009-openbao-secrets-byok.md) | Manage secrets with OpenBao envelope encryption and bring-your-own-key references | Accepted | §1.1, §3.1, §5, §8 |
| [0010](0010-postgres-rls-multi-tenancy.md) | Make the SaaS multi-tenant with Postgres row-level security as the isolation backbone | Accepted | §1.1, §5, §7, §8 |
| [0011](0011-gvisor-sandboxes-on-k3s.md) | Isolate agent sessions in gVisor sandboxes on k3s and never expose the host Docker socket | Accepted | §1.1, §4.1, §5, §8 |

ADR-0008, ADR-0010 and ADR-0011 record the security-critical decisions (fail-closed egress, row-level security,
no host container socket) behind the [§8 security invariants](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch).

## Adding or changing a decision

1. Copy [`template.md`](template.md) to the next free number, `NNNN-kebab-case-title.md`. Numbers are never
   reused or skipped.
2. Fill in Status, Context, Decision, Consequences and References. Cite the Context Pack section the decision
   comes from with a heading link. A new decision that the pack does not yet record changes the pack in the
   same change.
3. Add a row to the index above with the same title and status.
4. Run `pnpm check:adr`.

Accepted ADRs are immutable. To reverse or amend one, write a new ADR whose Status says
`Supersedes [ADR-NNNN](…)`, change the old ADR's status line to `Superseded by [ADR-MMMM](…)`, and update both
rows here. Per-epic decisions are added by the epics that make them.

## Checks

`pnpm check:adr` (`scripts/check-adr.mjs`) fails when:

- a file name, number or `# ADR-NNNN:` title is malformed, duplicated or out of sequence;
- a required section is missing or out of order, or the status is not a recognised value;
- a supersession is one-sided or points at a missing or wrong ADR;
- an ADR cites no Context Pack heading, links to a heading or file that does not exist, or mentions a `§N`
  that is not in the pack;
- this index misses an ADR, lists one that does not exist, or disagrees with an ADR's title or status;
- the Markdown is malformed (heading levels, blank lines, trailing whitespace, tabs, unclosed fences) or an
  ADR grows past its length limit.

Its self-tests (`scripts/check-adr.test.mjs`) run in `pnpm test`.
