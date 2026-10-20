# Label catalogue

Every GitHub label in this repository is defined in [`.github/labels.yml`](../.github/labels.yml). That file is
the single source of truth: change labels there, never in the GitHub UI. This page explains when to apply each
group. The tables at the end are generated from the file.

## How labels are applied

A planned issue (written to [CONTEXT_PACK §11](architecture/CONTEXT_PACK.md#11-issue-writing-standard-for-generators))
carries these labels:

| Group | How many | Rule |
|---|---|---|
| `type:*` | exactly 1 | `type:task` for a PR-sized unit, `type:epic` for an epic's parent issue, `type:spike` for a time-boxed investigation. Bug reports carry `bug` instead. |
| `priority:*` | exactly 1 on tasks and epics | `P0` is needed for the first end-to-end grey-box run, `P1` is a v1 must-have, `P2` a v1 should-have, `P3` nice-to-have or Later. |
| `size:*` | exactly 1 on tasks | `XS` < 2 h, `S` ≤ 0.5 d, `M` ≤ 1 d, `L` ≤ 2 d. There is no XL: split the issue. |
| `area:*` | exactly 1 on tasks and epics | The epic's Area in [EPICS.md](architecture/EPICS.md). |
| `epic:*` | exactly 1 on tasks and epics | The epic key in [EPICS.md](architecture/EPICS.md). A task's key starts with it (`EGRESS-004` → `epic:EGRESS`). |
| Functional (`security`, `gate`, `agent`, `infra`) | 0 or more | Apply each one the change touches. `security` means a [§8](architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch) invariant or a security-owned path ([code owners](runbooks/code-owners.md)) is involved, and the PR needs security review. |
| Feature (`F1` … `F44`) | 0 or more | Each feature from [FEATURE_LIST.md](architecture/FEATURE_LIST.md) the issue implements. |
| Workflow | 0 or more | `v1` / `later` for release scope. `discovered` for work raised while building another issue. `online-porting` + `offline-stub` for work that used a local substitute and must be ported online before go-live. |
| GitHub defaults | as needed | `bug` (set by the bug template), `duplicate`, `invalid`, `wontfix`, `question` and so on for triage. |

The [issue templates](../.github/ISSUE_TEMPLATE) ask for the key, epic, area, priority, size, features and
dependencies. Issue forms can only set fixed labels, so the Task template sets `type:task` and the Bug template
sets `bug`. Whoever triages the issue applies the other labels from those fields. Each dropdown in the templates
lists exactly the values of its label group, and `scripts/check-github.mjs` fails when they drift apart.

## Changing labels

1. Edit [`.github/labels.yml`](../.github/labels.yml). Names are unique ignoring case (GitHub compares label names
   case-insensitively), at most 50 characters, with no commas. Colors are 6 hex digits without `#`, quoted (an
   unquoted `000000` would be read as a number). Descriptions are 1-100 characters. A label in a group with a
   `prefix` must start with it.
2. **Renaming:** change `name` and add the old name under `previously:`. The sync then renames the label in place,
   so every issue keeps it, instead of creating a second label. Remove the `previously:` entry once the rename has
   been applied.
3. Regenerate the tables on this page with `node scripts/sync-labels.mjs --write-docs`. `pnpm labels:check` (and
   `pnpm test`) fail while this page is out of date.
4. Preview the change against the live labels without touching them:

   ```sh
   gh label list --repo TinycrowsLab/Blacwing_SAAS --json name,color,description --limit 500 > /tmp/labels.json
   node scripts/sync-labels.mjs --dry-run --current /tmp/labels.json
   ```

## The sync script

`scripts/sync-labels.mjs` validates the catalogue and reconciles a repository's labels with it. The CI label-sync
job (#844) runs it. It is idempotent: a second run right after a successful one changes nothing.

| Command | Does |
|---|---|
| `node scripts/sync-labels.mjs --dry-run` | Validates the catalogue and lists every label. Writes nothing. |
| `… --dry-run --current <file.json>` | Also prints the diff against a snapshot (`gh label list --json name,color,description` format). |
| `… --dry-run --repo OWNER/NAME` | Reads the live labels through the GitHub API (`GITHUB_TOKEN` or `GH_TOKEN`) and prints the diff. |
| `… --repo OWNER/NAME` | Applies the diff, then re-reads the labels and fails unless nothing is left to change. |
| `--prune` | Also deletes labels that are not in the catalogue. Without it they are reported as `extra` and kept. |
| `--fail-on-diff` | Exits 1 when the diff is not empty (drift check). |
| `--json` | Prints a machine-readable report. |
| `--write-docs` / `--check-docs` | Regenerates / checks the tables below. |

The diff lists each label as `create`, `update` (color, description or a case-only name change), `rename` (found
under a `previously:` name), `delete` (only with `--prune`), `unchanged` or `extra`. If a label and one of its
previous names both exist, the script updates the label, keeps the old one and prints a warning, because the old
label's issues have to be moved by hand first. A failed API call stops the run and reports what was applied
already. Re-running continues from there, because the diff is recomputed each time. The token is only sent in the
`Authorization` header and never printed.

## Catalogue

<!-- BEGIN GENERATED LABEL CATALOGUE: node scripts/sync-labels.mjs --write-docs -->

_Generated from `.github/labels.yml`: 158 labels in 9 groups. Do not edit by hand._

### Type (`type`, 3)

What kind of planned work an issue is. Every planned issue carries exactly one; bug reports carry `bug` instead.

| Label | Color | Description |
|---|---|---|
| `type:epic` | `#5319E7` | Epic: parent issue that groups the task issues of one epic (docs/architecture/EPICS.md) |
| `type:task` | `#1D76DB` | Task: one PR-sized unit of work written to the CONTEXT_PACK §11 standard |
| `type:spike` | `#C5DEF5` | Spike: time-boxed investigation that ends in a decision or an ADR |

### Priority (`priority`, 4)

Delivery priority (CONTEXT_PACK §11). Every planned task and epic carries exactly one.

| Label | Color | Description |
|---|---|---|
| `priority:P0` | `#B60205` | P0: needed for the first end-to-end grey-box run |
| `priority:P1` | `#D93F0B` | P1: v1 must-have |
| `priority:P2` | `#FBCA04` | P2: v1 should-have |
| `priority:P3` | `#0E8A16` | P3: nice-to-have or Later |

### Size (`size`, 4)

Effort estimate (CONTEXT_PACK §11). Every planned task carries exactly one; there is no XL, split the issue instead.

| Label | Color | Description |
|---|---|---|
| `size:XS` | `#C2E0C6` | Size XS: under 2 hours |
| `size:S` | `#BFDADC` | Size S: up to half a day |
| `size:M` | `#BFD4F2` | Size M: up to one day |
| `size:L` | `#D4C5F9` | Size L: up to two days (anything larger must be split) |

### Area (`area`, 15)

Architecture area the work belongs to, as listed in the Area column of docs/architecture/EPICS.md. Every planned task and epic carries exactly one.

| Label | Color | Description |
|---|---|---|
| `area:foundations` | `#D93F0B` | Architecture area: Foundations |
| `area:infrastructure` | `#5B2C6F` | Architecture area: Infrastructure |
| `area:tenancy` | `#4527A0` | Architecture area: Tenancy |
| `area:access-layer` | `#0366D6` | Architecture area: Access Layer |
| `area:platform-services` | `#00838F` | Architecture area: Platform Services |
| `area:authorisation-policy` | `#006B75` | Architecture area: Authorisation & Policy |
| `area:execution-sandbox` | `#0E8A16` | Architecture area: Execution Sandbox |
| `area:validation-findings` | `#BF360C` | Architecture area: Validation & Findings |
| `area:model-memory` | `#795548` | Architecture area: Model & Memory |
| `area:agent-runtime` | `#5319E7` | Architecture area: Agent Runtime |
| `area:recon-specialists` | `#2E7D32` | Architecture area: Recon & Specialists |
| `area:triage-delivery` | `#37474F` | Architecture area: Triage & Delivery |
| `area:console` | `#B60205` | Architecture area: Console |
| `area:production-readiness` | `#AD1457` | Architecture area: Production Readiness |
| `area:backlog` | `#1D76DB` | Architecture area: Backlog |

### Epic (`epic`, 69)

Epic the issue belongs to, keyed by the epic key in docs/architecture/EPICS.md. Every planned task and epic carries exactly one.

| Label | Color | Description |
|---|---|---|
| `epic:FOUND` | `#0E4429` | FOUND - Monorepo, shared libraries & engineering conventions |
| `epic:DEVENV` | `#0E4429` | DEVENV - Developer environment on AWS EC2 and local dependency stack |
| `epic:CI` | `#0E4429` | CI - CI/CD pipelines, supply-chain security & release engineering |
| `epic:INFRA` | `#0E4429` | INFRA - AWS infrastructure (OpenTofu), k3s cluster, networking, DNS & TLS |
| `epic:TENANT` | `#0E4429` | TENANT - Multi-tenant SaaS core: organisations, onboarding & isolation |
| `epic:IAM` | `#0E4429` | IAM - Identity, SSO (Keycloak) & session management |
| `epic:RBAC` | `#0E4429` | RBAC - Roles, permissions, service accounts & scoped CI tokens |
| `epic:API` | `#0E4429` | API - API platform: REST & GraphQL conventions |
| `epic:DB` | `#0E4429` | DB - PostgreSQL schema, migrations, RLS & data-access layer |
| `epic:GRAPH` | `#0E4429` | GRAPH - Asset & surface graph (Neo4j) |
| `epic:WORKFLOW` | `#0E4429` | WORKFLOW - Durable workflow & job infrastructure (Temporal, queues, events) |
| `epic:AUDIT` | `#0E4429` | AUDIT - Audit ledger & SIEM export |
| `epic:SECRETS` | `#0E4429` | SECRETS - Secrets service, envelope encryption & customer key stores |
| `epic:NOTIFY` | `#0E4429` | NOTIFY - Notification service: email, chat, webhooks & paging |
| `epic:ASSET` | `#0E4429` | ASSET - Asset inventory, ownership verification & environment attestation |
| `epic:SCOPE` | `#0E4429` | SCOPE - Scoping form, mode & input manifest, intrusiveness & request budgets |
| `epic:AUTHZ` | `#0E4429` | AUTHZ - Standing authorisation register & separation of duties |
| `epic:POLICY` | `#0E4429` | POLICY - Policy decision point & customer-owned policy layer (Cedar) |
| `epic:PLAN` | `#0E4429` | PLAN - Test-plan model, editable plan & Gate 1 approval |
| `epic:SANDBOX` | `#0E4429` | SANDBOX - Sandbox controller & disposable run sandboxes |
| `epic:IMAGE` | `#0E4429` | IMAGE - Sandbox image & security toolchain |
| `epic:EGRESS` | `#0E4429` | EGRESS - Scoped egress gateway (Go): allowlist, budgets, capture, fail-closed |
| `epic:SESSION` | `#0E4429` | SESSION - Session & credential manager: multi-role logins, keep-alive, lockout guard |
| `epic:BROWSER` | `#0E4429` | BROWSER - Browser automation runtime (Playwright) |
| `epic:OOB` | `#0E4429` | OOB - Out-of-band listener (interactsh) & correlation |
| `epic:KILL` | `#0E4429` | KILL - Kill switch, test-window notices & Customer SOC access |
| `epic:GATEWAY` | `#0E4429` | GATEWAY - Model gateway: Claude routing, virtual keys, redaction, cost caps & pinning |
| `epic:RUNTIME` | `#0E4429` | RUNTIME - Agent runtime host on the Claude Agent SDK |
| `epic:ORCH` | `#0E4429` | ORCH - Run orchestration: Temporal run workflow & orchestrator agent |
| `epic:REGISTRY` | `#0E4429` | REGISTRY - Agent registry, personas, prompt versioning & model tiers |
| `epic:MCP` | `#0E4429` | MCP - Blackwing MCP tool layer for agents |
| `epic:MEMORY` | `#0E4429` | MEMORY - Context manager, engagement journal & memory/knowledge |
| `epic:GATE2` | `#0E4429` | GATE2 - Runtime exception gate (Gate 2) & on-call paging |
| `epic:MENTOR` | `#0E4429` | MENTOR - Mentor & Reflector (stall detection & recovery) |
| `epic:RECON` | `#0E4429` | RECON - Recon agents: passive recon, OSINT, active recon & session setup |
| `epic:INTEL` | `#0E4429` | INTEL - Threat intelligence & enrichment |
| `epic:INGEST` | `#0E4429` | INGEST - Source & spec ingestion (grey/white box) |
| `epic:PLANNER` | `#0E4429` | PLANNER - Planner & sub-planner agents |
| `epic:WEBAPI` | `#0E4429` | WEBAPI - Web & API assessment specialist |
| `epic:AUTHLOGIC` | `#0E4429` | AUTHLOGIC - Authorisation, access-control & business-logic specialist |
| `epic:INFRASPEC` | `#0E4429` | INFRASPEC - Infrastructure & configuration specialist |
| `epic:CODESPEC` | `#0E4429` | CODESPEC - Code (white-box) specialist |
| `epic:EXPLOIT` | `#0E4429` | EXPLOIT - Exploit developer & tooling support (sandbox-only, non-destructive) |
| `epic:VALIDATE` | `#0E4429` | VALIDATE - Validator: deterministic replay, negative controls & confirmed/suspected |
| `epic:EVIDENCE` | `#0E4429` | EVIDENCE - Evidence store (write-once, hashed) & chain of custody |
| `epic:FINDING` | `#0E4429` | FINDING - Findings model, dedup & fingerprinting, severity & mapping |
| `epic:COVERAGE` | `#0E4429` | COVERAGE - Coverage manifest & export gate |
| `epic:REVERSAL` | `#0E4429` | REVERSAL - Reversal journal (undo of state changes) |
| `epic:REPRO` | `#0E4429` | REPRO - Standalone repro artifacts |
| `epic:TRIAGE` | `#0E4429` | TRIAGE - Triage & release (Gate 3) & auto-release lanes |
| `epic:REPORT` | `#0E4429` | REPORT - Report generation & export (PDF/JSON/SARIF) |
| `epic:CONNECT` | `#0E4429` | CONNECT - Issue-tracker & SCM integrations (Jira, GitHub/GitLab) |
| `epic:REMEDIATE` | `#0E4429` | REMEDIATE - Remediation guidance & one-click retest |
| `epic:BASELINE` | `#0E4429` | BASELINE - Baseline runs & diff (new/open/fixed/returned) |
| `epic:CONSOLE` | `#0E4429` | CONSOLE - Web console shell, navigation & design system |
| `epic:LIVERUN` | `#0E4429` | LIVERUN - Live run view & run management |
| `epic:DASH` | `#0E4429` | DASH - Vulnerability dashboard & reporting views |
| `epic:ADMIN` | `#0E4429` | ADMIN - Organisation administration & platform-operator console |
| `epic:SOCUI` | `#0E4429` | SOCUI - Customer SOC portal |
| `epic:OBS` | `#0E4429` | OBS - Observability: telemetry, metrics, logs, traces & alerting |
| `epic:COST` | `#0E4429` | COST - Token & cost tracking, budgets & spend caps |
| `epic:SCHED` | `#0E4429` | SCHED - Scheduler: recurring runs & blackout windows |
| `epic:RETAIN` | `#0E4429` | RETAIN - Retention, data lifecycle & deletion |
| `epic:EVAL` | `#0E4429` | EVAL - Evaluation harness & regression gate |
| `epic:SECREVIEW` | `#0E4429` | SECREVIEW - Security hardening, threat model & pre-launch review |
| `epic:PERF` | `#0E4429` | PERF - Performance, load & resilience testing |
| `epic:DOCS` | `#0E4429` | DOCS - Documentation, runbooks & onboarding |
| `epic:LAUNCH` | `#0E4429` | LAUNCH - End-to-end integration, UAT & launch readiness |
| `epic:LATER` | `#0E4429` | LATER - Post-v1 backlog (tracked, not built in v1) |

### Functional (`functional`, 4)

Cross-cutting concerns the issue touches; apply every one that fits (zero or more).

| Label | Color | Description |
|---|---|---|
| `security` | `#B60205` | Touches a CONTEXT_PACK §8 security invariant or a security-owned path; needs security review |
| `gate` | `#0052CC` | Touches a human approval gate (scope, Gate 1, Gate 2 or Gate 3) or separation of duties |
| `agent` | `#6F42C1` | Touches the agent runtime, personas, prompts or the Blackwing MCP tools |
| `infra` | `#455A64` | Touches infrastructure, CI/CD, the dev stack or repository tooling |

### Feature (`feature`, 44)

Feature IDs from docs/architecture/FEATURE_LIST.md the issue implements; apply every one that fits (zero or more).

| Label | Color | Description |
|---|---|---|
| `F1` | `#EDEDED` | F1 Scoping form |
| `F2` | `#EDEDED` | F2 Editable test plan |
| `F3` | `#EDEDED` | F3 Standing authorisation |
| `F4` | `#EDEDED` | F4 Intrusiveness class |
| `F5` | `#EDEDED` | F5 Request budget per test case |
| `F6` | `#EDEDED` | F6 Environment attestation |
| `F7` | `#EDEDED` | F7 Three assessment modes |
| `F8` | `#EDEDED` | F8 Grey-box web and API testing |
| `F9` | `#EDEDED` | F9 Multi-role authorisation matrix |
| `F10` | `#EDEDED` | F10 Session manager |
| `F11` | `#EDEDED` | F11 Scoped egress proxy |
| `F12` | `#EDEDED` | F12 Agent team |
| `F13` | `#EDEDED` | F13 Runtime exception gate (Gate 2) |
| `F14` | `#EDEDED` | F14 Validator agent |
| `F15` | `#EDEDED` | F15 Out-of-band listener |
| `F16` | `#EDEDED` | F16 Negative controls |
| `F17` | `#EDEDED` | F17 Confirmed and Suspected lists |
| `F18` | `#EDEDED` | F18 Standalone repro artifact |
| `F19` | `#EDEDED` | F19 Coverage manifest |
| `F20` | `#EDEDED` | F20 Reversal journal |
| `F21` | `#EDEDED` | F21 Triage gate (Gate 3) |
| `F22` | `#EDEDED` | F22 Dedup and fingerprinting |
| `F23` | `#EDEDED` | F23 Baseline run |
| `F24` | `#EDEDED` | F24 One-click retest |
| `F25` | `#EDEDED` | F25 Report export |
| `F26` | `#EDEDED` | F26 OWASP and CWE mapping |
| `F27` | `#EDEDED` | F27 Jira and GitHub or GitLab push |
| `F28` | `#EDEDED` | F28 Vulnerability dashboard |
| `F29` | `#EDEDED` | F29 One web console |
| `F30` | `#EDEDED` | F30 SSO |
| `F31` | `#EDEDED` | F31 Separation of duties |
| `F32` | `#EDEDED` | F32 Customer-owned policy layer |
| `F33` | `#EDEDED` | F33 Kill switch |
| `F34` | `#EDEDED` | F34 Audit ledger |
| `F35` | `#EDEDED` | F35 Secrets on customer key store |
| `F36` | `#EDEDED` | F36 Bring your own model |
| `F37` | `#EDEDED` | F37 Pinned versions |
| `F38` | `#EDEDED` | F38 Cost cap |
| `F39` | `#EDEDED` | F39 Retention |
| `F40` | `#EDEDED` | F40 Evaluation harness |
| `F41` | `#EDEDED` | F41 Single-node deployment |
| `F42` | `#EDEDED` | F42 Bitbucket, Azure DevOps and ServiceNow integrations (Later) |
| `F43` | `#EDEDED` | F43 Diff-driven continuous assessment (Later) |
| `F44` | `#EDEDED` | F44 Auto-release lane in triage (Later) |

### Workflow (`workflow`, 6)

Build-process markers used by the issue workflow and the release plan.

| Label | Color | Description |
|---|---|---|
| `v1` | `#0E8A16` | In the v1 release scope |
| `later` | `#CFD3D7` | Post-v1 backlog: tracked, not built in v1 |
| `discovered` | `#FBCA04` | Raised by the build agents while implementing another issue |
| `online-porting` | `#1D76DB` | Work stubbed while building offline; port to the online/cloud equivalent before go-live |
| `offline-stub` | `#FBCA04` | A code path using an offline/local substitute for a cloud/online dependency |
| `migration-squash` | `#B60205` | Deliberate baseline migration squash: exempts the PR from the forward-only drift check |

### GitHub defaults (`github`, 9)

GitHub default labels, kept so external reports and the bug template have stable labels.

| Label | Color | Description |
|---|---|---|
| `bug` | `#D73A4A` | Something isn't working: a defect in behaviour that has already landed |
| `documentation` | `#0075CA` | Improvements or additions to documentation |
| `duplicate` | `#CFD3D7` | This issue or pull request already exists |
| `enhancement` | `#A2EEEF` | New feature or request (triage into a type:task before building) |
| `good first issue` | `#7057FF` | Good for newcomers |
| `help wanted` | `#008672` | Extra attention is needed |
| `invalid` | `#E4E669` | This doesn't seem right |
| `question` | `#D876E3` | Further information is requested |
| `wontfix` | `#FFFFFF` | This will not be worked on |

<!-- END GENERATED LABEL CATALOGUE -->
