# ADR-0002: Build Blackwing from scratch in one pnpm and Turborepo monorepo

Date: 2026-10-20

## Status

Accepted

## Context

Blackwing is nine apps (eight in TypeScript, the egress gateway in Go) plus 25 shared libraries: contracts,
db, domain, policy, audit and so on. They share Zod contracts, configuration, logging and error handling, and a
change to a contract has to land in its producers and consumers together. The SaaS edition is built from
scratch: PentAGI is not used.

## Decision

- We keep every Blackwing component in a single repository, built from scratch. No third-party pentest-agent
  framework (PentAGI included) is vendored or forked.
- The TypeScript side is a **pnpm workspace** (`apps/*`, `packages/*`, shared libraries published as
  `@blackwing/<dir>`) on **Node.js 22 LTS**, with **Turborepo** as the task runner for build, lint, typecheck
  and test.
- The egress gateway is a **Go module** under `apps/egress-gateway`, in the same repository but outside the pnpm
  build graph (see [ADR-0008](0008-go-egress-gateway-fail-closed.md)).
- The directory layout is the one fixed by the Context Pack, and it is checked mechanically.

## Consequences

- One lockfile and one pull request can change a contract and every consumer atomically; Turborepo's
  dependency-ordered, cached pipeline keeps that affordable.
- Package boundaries need explicit enforcement (apps never import other apps, no deep imports), which the
  dependency-graph rules (FOUND-005, #7) provide.
- The Go module has its own toolchain and lint (golangci-lint) and is wired into CI separately.
- Adding or removing an app, package or fixed directory is a layout change: the Context Pack §6 and the layout
  check change together.

## References

- [Context Pack §1.1 Deliberate overrides](../architecture/CONTEXT_PACK.md#11-what-changed-versus-the-original-feature-list-deliberate-overrides):
  row "PentAGI: not used. Everything is built from scratch."
- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  rows "Languages" and "Monorepo".
- [Context Pack §6 Repository layout](../architecture/CONTEXT_PACK.md#6-repository-layout-create-exactly-this).
