# CLAUDE.md: working in the Blackwing repository

Read this before changing anything. It tells you how to work here. The normative design lives in
[`docs/architecture/CONTEXT_PACK.md`](docs/architecture/CONTEXT_PACK.md) (the "pack"). This file links to
the pack instead of copying it. When the two disagree, the pack wins. An issue's explicit text wins for that
issue only, and the issue must say so.

## Project overview

Blackwing is a multi-tenant SaaS that runs autonomous security assessments, but only under human authorisation.
Customers register assets and sign an expiring standing authorisation. AI agents then recon, plan and execute
test cases inside disposable sandboxes. Agents reach targets only through a scoped, fail-closed egress gateway.
A deterministic validator proves every finding, and humans approve at three gates (scope, runtime exception,
release). A kill switch stops everything. The product's agents run on the Claude Agent SDK, through the
Blackwing model gateway. You (a developer, or a Claude Code session building Blackwing) are not part of that
runtime. See [§1](docs/architecture/CONTEXT_PACK.md#1-product-in-one-paragraph) and
[§4](docs/architecture/CONTEXT_PACK.md#4-claude-code-as-the-agent-runtime-critical-design).

## Read first

| What | Where |
|---|---|
| Fixed stack and TypeScript conventions | [pack §5](docs/architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage) |
| Repository layout (exact) | [pack §6](docs/architecture/CONTEXT_PACK.md#6-repository-layout-create-exactly-this) |
| Security invariants | [pack §8](docs/architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch) |
| Dev workflow and Definition of Done | [pack §10](docs/architecture/CONTEXT_PACK.md#10-development-environment--workflow) |
| Policy, terms and branding constraints | [pack §4.5](docs/architecture/CONTEXT_PACK.md#45-policy--terms-constraints-must-follow) |
| SaaS overrides and what is not in v1 | [pack §1.1](docs/architecture/CONTEXT_PACK.md#11-what-changed-versus-the-original-feature-list-deliberate-overrides) |
| API conventions | [pack §9](docs/architecture/CONTEXT_PACK.md#9-api-conventions) |
| Architecture decision records (index) | [`docs/adr/README.md`](docs/adr/README.md) (FOUND-015, #17) |
| Allowed package dependency graph | [`docs/architecture/dependency-graph.md`](docs/architecture/dependency-graph.md) (FOUND-005, #7) |
| Epics and features | [`EPICS.md`](docs/architecture/EPICS.md), [`FEATURE_LIST.md`](docs/architecture/FEATURE_LIST.md) |
| Vulnerability reporting | [`SECURITY.md`](SECURITY.md) |
| Labels, issue/PR templates and code owners | [`docs/labels.md`](docs/labels.md), [`docs/runbooks/code-owners.md`](docs/runbooks/code-owners.md) |

## Repository map

| Path | Holds |
|---|---|
| `apps/*` | Deployables: `web`, `api`, `worker`, `agent-runtime`, `sandbox-controller`, `model-gateway`, `session-manager`, `cli` (TypeScript), and `egress-gateway` (Go module). |
| `packages/*` | Shared libraries published as `@blackwing/<dir>`. Contracts, db, domain, policy, audit and so on. |
| `infra/` | `tofu/` (AWS), `helm/`, `k3s/`, `docker/` (Dockerfiles, sandbox image), `compose/` (dev stack). |
| `eval/` | Local vulnerable targets, ground truth, eval harness. |
| `docs/` | `adr/`, `architecture/`, `runbooks/`, `api/`, `user/`. |
| `design/` | The UI design exported from Claude Design. It is the source of truth for every GUI: design system, screens and `tokens.json`. See [`design/README.md`](design/README.md). |
| `scripts/` | Repo tooling with `node:test` self-tests. `check-layout.mjs` fails `pnpm install` when the layout drifts from §6. |

Pack §6 is the full layout. Adding or removing an app, package or fixed directory means updating §6 and
`scripts/check-layout.mjs` in the same change.

## Commands

| Command | Does |
|---|---|
| `pnpm install` | Installs the workspace. The preinstall hook checks the repo layout. |
| `pnpm dev:deps` | Starts the local dependency stack (`infra/compose/docker-compose.dev.yml`, compose project `bwdev`). |
| `pnpm dev` | Runs the apps with hot reload against that stack. |
| `pnpm test` | Unit tests (Vitest) and the `scripts/` self-tests. |
| `pnpm test:int` | Integration tests (Testcontainers, random ports). |
| `pnpm test:e2e` | Playwright e2e tests against the compose stack and a local Juice Shop. |
| `pnpm lint` | ESLint 9 (flat config, type-aware strict typescript-eslint), zero warnings, per member via Turborepo. `pnpm lint:report` writes JSON for CI. |
| `pnpm format` / `pnpm format:check` | Prettier: rewrite, or check, the whole repository. |
| `pnpm boundaries:check` | Architectural import and dependency boundaries (dependency-cruiser): the allowed DAG in [`dependency-graph.md`](docs/architecture/dependency-graph.md), no app-to-app or deep imports, no cycles. `pnpm boundaries:report` writes JSON for CI. |
| `pnpm typecheck` | `tsc -b` per member via Turborepo (cached): one strict base config, project references (see `docs/architecture/typescript.md`). |
| `pnpm build` | Builds every package in topological order (Turborepo). |
| `pnpm db:seed` | Seeds the demo tenant `acme`, users per role, a verified lab asset and an active SA. |
| `pnpm check:layout` / `pnpm check:claude-md` / `pnpm check:tsconfig` / `pnpm check:turbo` | Repo-layout, CLAUDE.md, tsconfig and Turborepo pipeline drift checks. |
| `pnpm check:adr` | ADR format, Context Pack citations, supersession links and the index (`docs/adr/`). |
| `pnpm check:github` / `pnpm labels:check` | Issue/PR templates, CODEOWNERS and label-catalogue checks. `pnpm labels:sync --dry-run` lists the catalogue. |

Root scripts run through Turborepo (`turbo.json`, local cache only; see the README). Each script arrives with the
issue that owns it: lint in FOUND-004 (#6), the dev stack in DEVENV-010 (#164), seed data in DEVENV-011 (#165).
If a script is missing, that issue has not landed yet. Do not improvise a substitute in another issue. Go code
under `apps/egress-gateway` uses its `Makefile` (`make build test lint`, `make verify` for everything CI runs; see
`apps/egress-gateway/README.md`).

## Coding conventions

The rules are in [§5](docs/architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage).
In short:

- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on. **No `any`**
  (it is a lint error) and no non-null assertions. Node 22, ESM.
- **Validate at the boundary with Zod.** Every external input (HTTP, queue, env, file, tool output, upstream API) is
  parsed with Zod. Shared schemas live in `@blackwing/contracts`.
- **Logging goes only through `@blackwing/logger`** (pino, structured JSON, redaction). Do not use `console.*` in
  product code.
- **Environment goes only through `@blackwing/config`** (typed, fail-fast). Do not read `process.env` anywhere else.
- **Errors go through `@blackwing/errors`.** Throw `AppError` subclasses with stable `code`s. The API maps them to
  RFC 9457 problem+json.
- **IDs and time.** Use UUIDv7 and prefixed public IDs via `@blackwing/ids`, and ISO-8601 UTC via `@blackwing/time`.
  Test fixtures and Testcontainers helpers live in `@blackwing/testing`.
- **Reuse before you add.** Use the existing packages and the stack in §5. Do not add alternatives. Respect the
  dependency graph: apps never import other apps, and deep imports (`@blackwing/x/src/...`) are not allowed.
- **Data access** goes through `withTenant` (RLS, `SET LOCAL app.tenant_id`). A missing tenant context fails closed.
  Every data-access module needs cross-tenant tests.
- **GUI follows `design/`.** Any change to `apps/web`, `packages/ui`, the SOC or emergency pages, or report and
  e-mail templates must match [`design/`](design/README.md). Use its tokens via `packages/ui` (never hard-coded hex),
  its components and states, and its screen layouts. Where the design is silent, compose from its system.
- **Offline substitutes.** When a local fake stands in for something that must go online later, mark the site with
  `OFFLINE-STUB(online-porting #N): <why>` and link the `online-porting` issue.

## Security invariants

[§8](docs/architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch)
is normative. Every change preserves all of it, and tests must prove the invariants the change touches. Summary:
signed, unexpired envelope before any target traffic; egress fails closed; the destructive class is never allowed;
separation of duties (requester ≠ approver); a measured kill switch; tenant isolation everywhere; secrets never
reach the model, the logs or the sandbox in plaintext; an append-only audit ledger; pinned versions per run;
ownership verification; no model-dependent safety. If you cannot meet one, fail closed and raise an issue.
Never relax the invariant.

## Definition of Done

Apply the checklist in [§10](docs/architecture/CONTEXT_PACK.md#definition-of-done-applies-to-every-issue) to every
change:

- [ ] All acceptance criteria are met and demonstrably tested (unit; integration where IO is involved; e2e for user-visible flows).
- [ ] Every edge case listed in the issue has an explicit test.
- [ ] Lint, typecheck and tests are green. **No `any`, no skipped tests (`.skip`/`.only`/`.todo`), no TODO without a linked issue** (`TODO(#123): …`).
- [ ] Tenant isolation, authz and audit events are covered wherever data or actions are touched.
- [ ] OpenAPI/GraphQL schema, Zod contracts, migrations and docs are updated in the same change.
- [ ] New paths have structured logs, metrics and traces, with no secrets in logs.
- [ ] §8 invariants are preserved, and threat considerations are noted in the PR.

## Branches, commits and PRs

- One issue is one PR-sized change. Do not mix unrelated concerns, and do not build what another issue owns
  (check its "Out of scope"). Leave a clean extension point instead.
- Branch: `<issue-key>-<slug>`, lowercase. For example `egress-004-request-budgets`.
- Commits: **Conventional Commits** (`feat|fix|docs|chore|refactor|test|build|ci|perf|revert`, optional scope = a
  workspace member such as `feat(egress-gateway): …`), enforced by commitlint (FOUND-006, #8).
- The PR body says `Closes #N` and fills in the PR template (FOUND-016, #18): acceptance-criteria checklist, DoD,
  security considerations, test evidence.
- No `Co-Authored-By` trailers or tool-attribution lines in commits, PRs, code or docs. Never force-push a shared
  branch, and never rewrite someone else's commits.

## Never do

- **Never expose the host Docker socket** (or any container-runtime socket) to a sandbox
  ([§1.1](docs/architecture/CONTEXT_PACK.md#11-what-changed-versus-the-original-feature-list-deliberate-overrides),
  [§4.1](docs/architecture/CONTEXT_PACK.md#41-topology)).
- **Never call the product "Claude Code".** It is "Blackwing", optionally "Powered by Claude"
  ([§4.5](docs/architecture/CONTEXT_PACK.md#45-policy--terms-constraints-must-follow)). Never let a Claude.ai
  subscription login power customer runs.
- **Never add exploit payloads to the repo.** No weaponised PoCs, payload lists or attack tooling aimed at real
  systems. Tests use benign oracles against local lab targets in `eval/targets`.
- **Never weaken a §8 invariant.** That includes doing it "temporarily", behind a flag, in dev, or to make a test
  pass. Never make safety depend on the model's compliance.
- **Never log secrets.** No credentials, tokens, keys or PII in logs, errors, fixtures, issues, commit messages or
  the repo. Use references, the redaction registry and `@blackwing/config` secrets.
- Never run destructive tests, and never point tooling at anything other than local labs or verified, authorised
  assets.
- Never disable a lint rule, skip a test or weaken a type to get green. Never add stack alternatives or v1 non-goals
  ([§1.1](docs/architecture/CONTEXT_PACK.md#11-what-changed-versus-the-original-feature-list-deliberate-overrides)).
