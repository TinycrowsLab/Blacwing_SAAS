# CLAUDE.md — working in the Blackwing repository

> A fuller version is produced by epic `FOUND`. This starter orients any Claude Code session.

## What this is
Blackwing: an authorised, human-gated autonomous security-assessment SaaS. Agent runtime = Claude Agent SDK. Read [`docs/architecture/CONTEXT_PACK.md`](docs/architecture/CONTEXT_PACK.md) before implementing anything.

## Non-negotiables (see CONTEXT_PACK §8)
- No target traffic without a valid, signature-verified, unexpired authorisation envelope; the egress gateway is the only route and **fails closed**.
- **Destructive testing is never allowed.** State-changing tests need approval + a reversal-journal entry.
- Separation of duties on all gates; tenant isolation everywhere (Postgres RLS, per-run sandboxes); secrets never reach the model, logs or sandbox in plaintext.
- Append-only audit ledger; pinned versions per run; safety is enforced by deterministic code, never by model compliance.
- Claude.ai subscription login must not power customer runs — use Anthropic API key / Bedrock / Vertex / Foundry via the model gateway.

## How to work
- One issue = one PR. Branch `<issue-key>-<slug>`, Conventional Commits, `Closes #N`.
- TypeScript strict; validate inputs with Zod; no `any`. Go for the egress gateway.
- Meet the Definition of Done in CONTEXT_PACK §10 (tests, isolation, audit, observability, docs) before opening the PR.
- Prefer the stack and paths already decided in CONTEXT_PACK §5–§6; don't introduce alternatives.
