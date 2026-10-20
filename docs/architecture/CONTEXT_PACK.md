# Blackwing SaaS v1: Engineering Context Pack

> Source of truth for every GitHub issue in `TinycrowsLab/Blacwing_SAAS`. An engineer or a Claude Code session picking up any issue can rely on the decisions below without asking for more context. Where an issue and this pack disagree, the issue's explicit text wins for that issue only, and the issue must say so.

---

## 1. Product in one paragraph

**Blackwing** is an autonomous security-assessment platform that runs **under human authorisation**. Customers register assets (web apps, APIs, hosts/network ranges, source repositories) and authorise testing with a signed, expiring **standing authorisation**. They then request assessments in **black-box, grey-box (primary mode) or white-box** mode. A team of AI agents runs recon, plans test cases, executes them inside disposable sandboxes and reaches targets **only through a scoped egress gateway**. Every candidate finding is proven by a deterministic **validator** with negative controls, and a human releases findings (**Gate 3**) before they reach reports and trackers. Three human gates exist:
- **Gate 1:** scope/test-plan approval.
- **Gate 2:** runtime exception, when an action falls outside the envelope.
- **Gate 3:** triage and release.

A **kill switch**, held by the customer's SOC, stops everything.

### 1.1 What changed versus the original feature list (deliberate overrides)
The original feature list (F1–F44) was written for a **single-tenant on-prem** product. This repository builds the **SaaS edition first**; an on-prem edition comes later. Overrides:

| Original | SaaS v1 decision |
|---|---|
| "Multi-tenant platform: not in v1" | **Reversed.** SaaS is multi-tenant: organisations are tenants, with strict isolation (Postgres RLS, per-tenant keys, per-run sandboxes, per-tenant egress policy). |
| F41 "Single-node deployment in customer's Azure/AWS" | Replaced by **Blackwing-operated SaaS on AWS EC2 (k3s)**. Keep the invariant "**host Docker socket is never exposed to sandboxes**". Keep deployment portable for a future on-prem mode (Later epic). |
| F36 "Bring your own model: Azure OpenAI, Bedrock, GCP, custom endpoint" | The agent runtime is **Claude Code (Claude Agent SDK)**, so models are **Claude only**. "Bring your own model" becomes **bring your own Claude endpoint**: Blackwing-managed Anthropic API (default), the customer's own Anthropic API key, the customer's **Amazon Bedrock**, **Google Vertex AI** or **Microsoft Foundry** Claude deployment. The guarantee "no data goes to other providers" is enforced by the model gateway. Azure OpenAI/GPT is **not supported**. |
| F35 "Secrets on customer key store" | Per-tenant envelope encryption via **OpenBao** (Blackwing-managed), with **BYOK/BYO-vault references**: customer AWS KMS (cross-account), customer HashiCorp Vault/OpenBao, AWS Secrets Manager, Azure Key Vault. |
| "PentAGI" | **Not used.** Everything is built from scratch. |

Still **NOT in v1** (do not build; reject scope creep): destructive tests, standalone SAST/SCA scanning products (white-box *uses* source to guide runtime tests; it does not ship SAST findings), build gating in CI (no "fail the build" feature), SLA tracking, chat-based scoping (the scoping form is structured), a second UI for developers (one console separated by roles), mobile app testing, billing/payments (plans and quotas only).

### 1.2 Personas (humans and systems)
- **AppSec Engineer:** operates runs, edits test plans, triages findings (Gate 3), manages assets.
- **Asset Owner:** authorises testing of an asset (signs the standing authorisation), approves Gate 1/Gate 2 for their assets, attests the environment.
- **Developer:** triggers pre-prod runs on assets assigned to them, consumes released findings, fixes them, triggers one-click retest.
- **CI/CD Pipeline:** unattended runs inside a standing authorisation, using scoped CI tokens.
- **Customer SOC:** receives test-window notices, holds the kill switch (no Blackwing account needed for the emergency kill link).
- **Auditor:** read-only access to the audit ledger, reports and coverage.
- **Org Owner/Admin:** SSO, roles, policies, connectors, secrets, retention and model settings.
- **Blackwing Platform Operator (Tinycrows staff):** tenant support, ownership-verification review queue, global kill switch, release management of models/prompts/tools. Fully separate from tenant roles, and every action is audited.

---

## 2. Feature catalogue (IDs used in issues)
`F1` Scoping form · `F2` Editable test plan · `F3` Standing authorisation · `F4` Intrusiveness class (passive / active-safe / state-changing; destructive not in v1) · `F5` Request budget per test case · `F6` Environment attestation · `F7` Three assessment modes (grey box primary; recon skipped where context supplied) · `F8` Grey-box web & API testing with ≥2 roles · `F9` Multi-role authorisation matrix · `F10` Session manager · `F11` Scoped egress proxy · `F12` Agent team · `F13` Runtime exception gate (Gate 2; no reply = denied) · `F14` Validator agent (replay against a check declared before the test ran) · `F15` Out-of-band listener · `F16` Negative controls · `F17` Confirmed and Suspected lists · `F18` Standalone repro artifact · `F19` Coverage manifest (report cannot export without it) · `F20` Reversal journal · `F21` Triage gate (Gate 3) · `F22` Dedup & fingerprinting · `F23` Baseline run (new/open/fixed/returned) · `F24` One-click retest · `F25` Report export PDF/JSON/SARIF (+CSV/XML P2) · `F26` OWASP & CWE mapping · `F27` Jira and GitHub/GitLab push · `F28` Vulnerability dashboard · `F29` One web console (roles) · `F30` SSO (Microsoft, Google, GitHub, Slack) · `F31` Separation of duties · `F32` Customer-owned policy layer · `F33` Kill switch (halt time measured and shown) · `F34` Audit ledger · `F35` Secrets on customer key store · `F36` Bring your own (Claude) model · `F37` Pinned versions · `F38` Cost cap · `F39` Retention · `F40` Evaluation harness · `F41` Deployment (SaaS on AWS) · Later: `F42` Bitbucket/Azure DevOps/ServiceNow · `F43` Diff-driven continuous assessment · `F44` Auto-release lane in triage.

---

## 3. Architecture (SaaS)

### 3.1 Layers (from the component diagram) and where each lives
| Layer | Component | Implementation (repo path) |
|---|---|---|
| Access | Web Console | `apps/web` (Next.js) |
| Access | REST & GraphQL API (service accounts, scoped CI tokens) | `apps/api` (NestJS/Fastify) |
| Access | Identity & SSO | Keycloak 26 (Organizations, IdP brokering) + `apps/api` auth module |
| Authorisation & Policy | Standing Authorisation Register | `apps/api` module `authorisations` + `packages/crypto` |
| Authorisation & Policy | Scope & Test-Case Service | `apps/api` modules `scoping`, `test-plans` |
| Authorisation & Policy | Policy Decision Point | `packages/policy` (Cedar via `@cedar-policy/cedar-wasm`), Go mirror in `apps/egress-gateway` (`cedar-go`) |
| Agent Runtime | Orchestrator, Planner, Sub-planner, Agent Registry | `apps/worker` (Temporal run workflow) + `apps/agent-runtime` (Claude Agent SDK host) + `packages/agents` |
| Model & Memory | Model Gateway | `apps/model-gateway` (Anthropic-compatible proxy) |
| Model & Memory | Context Manager; Memory & Knowledge | `apps/agent-runtime` + `packages/memory` (Neo4j asset graph, pgvector) |
| Execution Sandbox | Scoped Egress Proxy | `apps/egress-gateway` (Go) |
| Execution Sandbox | Session & Credential Manager | `apps/session-manager` (TS service, also runs inside run network) |
| Execution Sandbox | Tool Runtime & Browser | `infra/docker/sandbox` image + `apps/sandbox-controller` |
| Validation & Findings | Validator | `apps/worker` validation activities + `packages/replay` (deterministic engine) |
| Validation & Findings | Out-of-band Listener | interactsh-server (self-hosted) + `packages/oob` client |
| Validation & Findings | Dedup & Fingerprinting | `packages/domain/findings` |
| Triage & Delivery | Triage & Release; Report & Export; Connectors & Notifications | `apps/api` modules + `packages/reporting`, `packages/connectors`, `packages/notify` |
| Platform Services | Secrets Service; Scheduler; Audit Ledger | OpenBao + `packages/secrets`; Temporal Schedules; `packages/audit` |
| Data & Evidence | Postgres+pgvector; Graph DB; Evidence Store; Redis | Postgres 16; Neo4j 5 Community; S3 (Object Lock) / MinIO in dev; Valkey 8 |
| Observability | Telemetry Collector; Token & Cost Tracking | OpenTelemetry Collector → Prometheus/Loki/Tempo/Grafana; `packages/cost` |

### 3.2 Request → result data flow (agent organisation)
1. **Assessment Request** (target asset(s), objective, mode, standing authorisation ID, budgets) is created via console, API or CI.
2. **Mode & Input Manifest** decides which recon agents run:
   - black box → Passive Recon + OSINT + Active Recon + Threat Intel;
   - grey box → Active Recon (confirm supplied surface) + Threat Intel + Source & Spec Ingestion + Session Setup;
   - white box → Source & Spec Ingestion + Threat Intel + Session Setup + minimal Active Recon to confirm the deployed surface.
3. **Preflight checks**:
   - targets resolve and are in scope;
   - credentials log in per role;
   - lockout exemption attested;
   - test window open;
   - SOC notice delivered;
   - budgets available;
   - model provider reachable.
4. **Recon** runs inside the standing authorisation (passive and active-safe only) and writes the **surface model** (Neo4j + Postgres).
5. **Planner** turns the surface model into **proposed test cases**. Each test case carries:
   - intrusiveness class;
   - request budget;
   - declared validation oracle;
   - OWASP/WSTG/ASVS reference;
   - target endpoints;
   - the roles used.
6. **Gate 1:** a human (not the requester; SoD) reviews, edits and approves the plan. That approval produces the **approved run envelope**. Auto-approval is allowed only when every test case is inside the standing authorisation's pre-approved classes and budgets. The decision is recorded as "approved under SA-xxx".
7. **Sub-planner** breaks approved test cases into subtasks. The **Orchestrator agent** delegates subtasks to **Assessment Specialists** (web & API, auth & logic, infrastructure, code), helped by the **Exploit Developer & Tooling** persona. **Mentor & Reflector** intervene on stalls.
8. Any action outside the envelope triggers **Gate 2**: the branch pauses, on-call is paged, and no reply by the timeout means **denied**.
9. Specialists submit **candidate findings**. The **Validator** replays each one deterministically in a fresh sandbox against its pre-declared oracle, with **negative controls**:
   - pass → **Confirmed** (evidence + standalone repro artifact);
   - fail → **Suspected** queue (analyst-only).
10. **Gate 3:** an analyst releases confirmed findings. Then the **Reporter** writes findings up (OWASP/CWE/compliance mapping) and **Remediation** produces fix guidance, raises tickets and schedules retest. Findings are tracked to closure on the dashboard and in trackers.

### 3.3 Run state machine (authoritative; implement in `packages/domain/run`)
`draft → preflight → recon → planning → awaiting_gate1 → approved → executing ⇄ paused (gate2_pending | cost_cap | operator_pause) → validating → awaiting_gate3 → released → reporting → completed`

Terminal states: `cancelled`, `killed`, `failed`, `expired` (standing authorisation expired mid-run → stop all traffic immediately).
- Every transition is a guarded function: actor, preconditions, audit event.
- Illegal transitions throw `IllegalRunTransitionError`.
- State is stored in Postgres (`runs.state`, with `state_version` used for optimistic concurrency) and driven by the Temporal `AssessmentRunWorkflow`.

### 3.4 Finding lifecycle
- **Validation:** `candidate → validating → confirmed | suspected`.
- **Triage:** `confirmed → released | rejected_false_positive | duplicate | accepted_risk` (accepted risk requires a reason + expiry).
- **Remediation:** `released → fixed` (a retest passes) `→ returned` (fixed then re-detected). `suspected` can be promoted only by a successful re-validation.
- **Baseline diff per asset:** `new | open | fixed | returned | not_retested`. A finding counts as `fixed` **only** if the coverage manifest shows the relevant test executed.

### 3.5 Intrusiveness classes (F4)
| Class | Meaning | v1 |
|---|---|---|
| `passive` | No crafted traffic to the target: OSINT, third-party sources, observing normal responses | allowed |
| `active_safe` | Crafted requests not expected to change state (probing, injection detection with benign payloads, auth checks with GET) | allowed |
| `state_changing` | Creates or modifies data in a reversible way. **Must** write a reversal-journal entry *before* executing | allowed only if the SA and Gate 1 explicitly include it |
| `destructive` | Irreversible or availability-impacting (DoS, deleting others' data, mass account lockout) | **hard-blocked by the platform baseline policy** |

---

## 4. Claude Code as the agent runtime (critical design)

The product's agents run on the **Claude Agent SDK (TypeScript, `@anthropic-ai/claude-agent-sdk`)**, which is Claude Code packaged as a library. Pin an exact SDK version in `apps/agent-runtime/package.json`; the SDK bundles the matching Claude Code binary.

### 4.1 Topology
- One **run** gets one isolated **run network**, its own egress-gateway policy instance (an identity on the shared gateway, keyed by run), and N **agent sandboxes**.
- Every **agent session** (one persona working one task) runs in its **own disposable sandbox container**: image `bw-sandbox`, gVisor `runsc`, non-root, read-only rootfs, tmpfs workspace, `--cap-drop ALL`, `no-new-privileges`, seccomp, pids/memory/CPU limits.
- The container runs `apps/agent-runtime`, which calls `query()` and hosts Blackwing MCP tools in-process (`createSdkMcpServer`).
- Sandbox egress is allowed to exactly three destinations: (1) the **egress gateway** (for target traffic), (2) the **model gateway** (for Claude), (3) the **Run Broker API** (internal API for tool backends, run-scoped token). Everything else is denied (Kubernetes NetworkPolicy plus host firewall). No internet, no cloud metadata endpoint (169.254.169.254 blocked), no access to other runs.
- Claude Code reaches Claude via `ANTHROPIC_BASE_URL=http://model-gateway…` and a **per-session virtual key** (`ANTHROPIC_API_KEY=bwk_…`, short-lived, scoped to run+session, revoked on kill). The real provider credentials never enter the sandbox.
- Target traffic uses `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` → egress gateway, plus a per-run MITM CA in the trust store (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`). Tools that ignore proxy env run under `proxychains-ng`.
- Proxy credentials encode **run/session/test-case/role** (`http://tc_<testCaseId>.role_<roleId>:<token>@egress:3128`), which is how budgets and role-session injection work.

### 4.2 Hybrid orchestration (why and how)
- The **Run Controller** is a deterministic Temporal workflow (`AssessmentRunWorkflow` in `apps/worker`). It owns phases, gates, budgets, kill, timeouts and retries. **LLMs decide; code enforces.**
- The **Orchestrator** is a long-running Claude Code session (persona `orchestrator`) with Blackwing MCP tools such as:
  - `get_engagement_state`
  - `list_open_subtasks`
  - `dispatch_subtask(persona, subtaskId, brief)`
  - `get_subtask_result`
  - `request_mentor_review`
  - `mark_test_case_status`
  - `request_scope_exception`
- `dispatch_subtask` does **not** use the in-process Agent tool. It signals the Run Controller, which starts a **new specialist session in a new sandbox** (Temporal child workflow `AgentSessionWorkflow`). This gives each specialist its own egress identity, budget, kill handle and resource limits, and scales across hosts.
- **Inside** a specialist session, native Claude Code subagents (`agents` option, `Agent` tool) are allowed for light helpers (e.g. `payload-crafter`, `response-differ`). Set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=4`, and remember helpers share the specialist's sandbox and egress identity.
- **Sub-planner** is a short structured-output session (`outputFormat: {type:'json_schema', schema}`) that converts approved test cases into subtasks.

### 4.3 Mandatory SDK options for every Blackwing session (`apps/agent-runtime/src/session/options.ts`)
- `settingSources: []`, `env: { ...minimalEnv, CLAUDE_CONFIG_DIR: <per-session dir>, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_* }`. Never inherit host env wholesale; the TS SDK `env` *replaces* the subprocess env.
- `cwd: /workspace/<sessionId>` (tmpfs).
- `model` comes from the run manifest; `fallbackModel` is only set if the tenant's provider policy allows it.
- `effort` per persona; `maxTurns` per persona (step ceiling); `maxBudgetUsd` = remaining session budget (secondary guard; the gateway is primary).
- `permissionMode: 'default'`, **never** `bypassPermissions`.
- `allowedTools` = the persona's allowlist. `disallowedTools` always includes `WebFetch`, `WebSearch` and other networked built-ins: those bypass or obscure the egress path, and OSINT uses Blackwing tools routed through the gateway's intelligence allowlist.
- `canUseTool` denies anything not explicitly allowed. There are no interactive prompts in sandboxes.
- `hooks`:
  - `PreToolUse`: policy check through the PDP.
    - Every Bash command and every MCP target-interaction tool call is evaluated against the envelope and the customer policy.
    - Out-of-envelope calls create a **Gate 2 exception**. If the turn has a single tool call, the hook returns `permissionDecision:'defer'` (the session ends with `stop_reason:'tool_deferred'` and `deferred_tool_use`). The Run Controller waits for the human decision (timeout ⇒ deny), resumes the session with `resume: sessionId`, and the hook then returns `allow` or `deny`.
    - If the call was part of a parallel batch (`defer` is ignored for batches), the hook returns `deny` with a reason, and the runtime pauses that branch.
    - `state_changing` calls without a prior reversal-journal entry are denied.
  - `PostToolUse`: audit, evidence capture, redaction of known secret values (`updatedToolOutput`), output truncation with pointer-to-evidence.
  - `PreCompact`: archive the full transcript.
  - `SessionStart` / `SessionEnd`, `SubagentStart` / `SubagentStop`: lifecycle telemetry.
  - `Stop`: completion check, e.g. the subtask result must have been submitted.
- `outputFormat` (JSON schema) for planner, sub-planner, validator-assistant and reporter personas.
- `sessionStore`: a Postgres/S3-backed adapter so sessions survive pod loss and can be resumed for Gate 2 and Mentor interventions.
- `abortController`: wired to the kill switch. `query.interrupt()` is used on operator pause.
- `includePartialMessages: true` for the live run view.

### 4.4 Result handling
Read `SDKResultMessage` for these fields:
- `subtype`: `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution` or `error_max_structured_output_retries`;
- `stop_reason`, including `tool_deferred`;
- `total_cost_usd`, `modelUsage` (per model; prefer it for accounting), `usage`, `num_turns`, `duration_ms`;
- `permission_denials`;
- `structured_output`.

Each outcome maps to a subtask status. **Model refusals:** if the model declines (refusal stop reason surfaced through the SDK/gateway), mark the subtask `model_declined` and record it in the coverage manifest. Never attempt to rephrase or evade; humans review. The eval harness tracks the refusal rate.

### 4.5 Policy & terms constraints (must follow)
- The production runtime authenticates with an **Anthropic API key** (Claude Developer Platform) or a cloud provider (**Amazon Bedrock**, Vertex AI, Microsoft Foundry). **Claude.ai subscription login must not power customer runs** (Agent SDK terms). Developers may use their Claude Code subscription only for *building* Blackwing.
- Branding: the product is "Blackwing" (optionally "Powered by Claude"). Never call the product "Claude Code".
- Every agent session's system prompt includes the **signed authorisation context**:
  - asset;
  - scope;
  - window;
  - allowed intrusiveness;
  - the approving identity.
  This truthfully establishes that testing is authorised. Agents must stay within it.
- **Prompt injection:** all target content (HTTP bodies, source code, DNS records, OSINT) is **untrusted data**. Enforcement never depends on model compliance: the PDP hook, egress gateway, budgets and kill switch are deterministic.

### 4.6 Persona roster (Agent Registry; `packages/agents/personas/*.ts`, prompts in `packages/agents/prompts/<persona>/<semver>.md`)
| Persona | Purpose | Default model tier | Key tools |
|---|---|---|---|
| orchestrator | Engagement state, delegation, completion | deep | engagement MCP tools only (no Bash) |
| planner | Surface model → test cases (structured) | deep | read surface model, test-case library |
| sub-planner | Test case → subtasks (structured) | standard | read-only |
| passive-recon | Black box only: DNS, certificate transparency, archives, tech fingerprint from third-party sources | standard | `intel_*` tools via gateway allowlist |
| osint | Black box only: org footprint, leaked creds metadata (no credential use), code leaks | standard | `intel_*` tools |
| active-recon | Black and grey box: crawl, port/service discovery, endpoint and parameter discovery inside scope | standard | Bash (httpx, naabu, katana, ffuf, dnsx), `http_request`, browser |
| threat-intel | All modes: CVE/KEV/EPSS/GHSA/OSV enrichment for detected components | standard | `intel_*` tools |
| source-spec-ingestion | Grey/white: OpenAPI/Postman/GraphQL/HAR/source → surface model | deep | Read/Grep/Glob on mounted inputs, parsers |
| session-setup | Any authenticated test: record/verify login per role | standard | session-manager tools, browser |
| web-api-specialist | Injection, XSS, SSRF, XXE, SSTI, path traversal, CORS, headers, GraphQL, mass assignment, file upload (safe), etc. | deep | Bash, `http_request`, browser, oob, journal, submit_candidate |
| auth-logic-specialist | Multi-role authorisation matrix, BOLA/BFLA/IDOR, privilege escalation, workflow/business-logic abuse, race conditions (state-changing only if approved) | deep | same + role-switching |
| infrastructure-specialist | Network services, TLS, exposed admin interfaces, known-vulnerable versions (proof at runtime) | standard | Bash (naabu, fingerprintx, testssl.sh, nuclei pinned templates), `tcp_probe` |
| code-specialist | White box: trace sources→sinks in code, prove at runtime, exposed secrets, dependency risk proven at runtime | deep | Read/Grep/Glob, opengrep, gitleaks, `http_request` |
| exploit-developer | Payloads, PoC scripts, harnesses, tool provisioning inside sandbox; never destructive | deep | Bash, Write/Edit in workspace |
| mentor | Detect stalls/loops, propose recovery strategy | standard | read transcript summary |
| reflector | Post-failure analysis, adjust plan, avoid repeated failures | standard | read-only |
| validator-assistant | Normalise candidate into a deterministic replay spec + oracle binding (does NOT judge) | deep | read-only + replay-spec schema |
| reporter | Finding write-up, impact, remediation, compliance mapping (structured) | deep | read-only |
| remediation | Fix guidance (code-level in white box), ticket text, retest plan | standard | read-only |

Model tier aliases resolve per tenant provider: `deep` → `claude-opus-5-5`, `standard` → `claude-opus-5-5` (may be lowered to `claude-sonnet-5-5` per eval results), `fast` → `claude-haiku-5-5`. Use exact model IDs, with no date suffixes. On Bedrock the IDs are prefixed with `anthropic.`. Default effort: `high` for deep personas, `medium` otherwise. Resolved values are pinned per run (F37).

---

## 5. Technology stack (fixed for v1; all free/open-source except the AWS account and the Anthropic/Claude usage)
| Concern | Choice |
|---|---|
| Languages | TypeScript 5.x on **Node.js 22 LTS** (all apps except the egress gateway); **Go 1.23+** for `apps/egress-gateway` |
| Monorepo | **pnpm** workspaces + **Turborepo**; Go module under `apps/egress-gateway` |
| Web | **Next.js 15** (App Router, RSC) + React 19, **Tailwind CSS 4**, **shadcn/ui** (Radix), TanStack Query + Table, React Hook Form + Zod, Recharts, `next-intl`-ready strings (English only v1) |
| API | **NestJS 11** with Fastify adapter; REST with OpenAPI 3.1 generated from Zod (`nestjs-zod`/`zod-openapi`); **GraphQL** via `@nestjs/graphql` code-first + Mercurius (read-focused queries for console/dashboard; mutations stay REST) |
| Contracts | **Zod** schemas in `packages/contracts` shared by api, web, worker, runtime, cli |
| DB | **PostgreSQL 16** + `pgvector` + `pgcrypto`; **Row-Level Security** on every tenant table |
| ORM / migrations | **Drizzle ORM** + drizzle-kit; SQL migrations committed and reviewed; forward-only in prod |
| Graph | **Neo4j 5 Community** (asset/surface graph); tenant isolation by mandatory `tenantId` property enforced by the repository layer |
| Durable workflows | **Temporal** (self-hosted, TS SDK): run lifecycle, gates (signals), timers (gate timeouts, windows), schedules (F-scheduler), retries |
| Queue / cache / pub-sub | **Valkey 8** (Redis-compatible, BSD) + **BullMQ** for short jobs; Redis Streams for live run events |
| Object storage | **AWS S3 with Object Lock** (staging/prod); **MinIO** with object locking (dev); access via AWS SDK v3 S3 client only |
| Secrets/KMS | **OpenBao** (Transit for envelope encryption, KV v2 for platform secrets); BYOK adapters (AWS KMS, external Vault/OpenBao, AWS Secrets Manager, Azure Key Vault) |
| Identity | **Keycloak 26** (Organizations, identity brokering: Microsoft Entra ID, Google, GitHub, Slack (OIDC), generic OIDC/SAML; MFA; brute-force detection). Console uses OIDC Auth Code + PKCE through a Next.js BFF with httpOnly cookies |
| Policy | **Cedar** (`@cedar-policy/cedar-wasm` in TS, `github.com/cedar-policy/cedar-go` in Go) with a shared schema and shared test vectors |
| Agents | **Claude Agent SDK (TS)**; models via **Blackwing Model Gateway** to Anthropic API / Amazon Bedrock (`@anthropic-ai/bedrock-sdk` Mantle client) / Vertex (`@anthropic-ai/vertex-sdk`) / Foundry (`@anthropic-ai/foundry-sdk`) |
| Embeddings (free) | Local **transformers.js** (`@huggingface/transformers`) with `bge-small-en-v1.5` (ONNX, CPU) → pgvector(384) |
| Sandbox isolation | **gVisor (`runsc`)** RuntimeClass on **k3s** (staging/prod) and Docker+`runsc` driver (dev & future on-prem) |
| Orchestration | **k3s** on EC2 (free) + **Helm**; Traefik ingress (k3s default) + **cert-manager** (Let's Encrypt) |
| IaC | **OpenTofu** (AWS provider) + cloud-init; no click-ops |
| Egress gateway | Go: `elazarl/goproxy` (MITM HTTP/1.1, HTTPS via per-run CA) + `things-go/go-socks5` (TCP) + `miekg/dns` (scoped DNS) + `cedar-go` |
| OOB | **interactsh-server** (projectdiscovery, MIT) self-hosted on a dedicated domain + TS client in `packages/oob` |
| Browser | **Playwright** + headless Chromium in sandbox; exposed to agents via **`@playwright/mcp`** (proxy-configured) |
| Security toolchain in sandbox | projectdiscovery `subfinder`, `dnsx`, `httpx`, `naabu`, `katana`, `nuclei` (+ pinned templates), `ffuf`, `sqlmap` (safe flags only), `testssl.sh`, `fingerprintx`, `gitleaks`, `opengrep`, `jq`, `proxychains-ng`, Python 3 stdlib. **License review gate**: nmap (NPSL) and Semgrep registry rules are NOT bundled unless legal sign-off |
| PDF | HTML templates rendered by Playwright/Chromium print-to-PDF (`packages/reporting`) |
| SARIF | 2.1.0, validated with Ajv against the official schema |
| Observability | OpenTelemetry SDK + Collector, **Prometheus**, **Loki**, **Tempo**, **Grafana**, Alertmanager. Claude Code OTel export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_*`) |
| Email | Nodemailer via SMTP (Amazon SES SMTP in prod, **Mailpit** in dev) |
| Testing | **Vitest** (unit), **Testcontainers** (integration), **Playwright** (e2e), Go `testing` + testify, **k6** (load), `@fast-check` property tests where useful |
| Quality | ESLint 9 flat config + typescript-eslint (strict), Prettier, golangci-lint, commitlint (Conventional Commits), Husky + lint-staged, `knip` for dead code |
| CI | **GitHub Actions** (free for this public repo); images on **GHCR**; **cosign** keyless signing; **Syft** SBOM; **Trivy** scan; Renovate for deps |
| Eval targets | OWASP Juice Shop, crAPI, VAmPI, DVGA (Damn Vulnerable GraphQL App), DVWA, WebGoat, plus Blackwing's own synthetic labs |

TypeScript conventions:
- `strict: true`, `noUncheckedIndexedAccess: true` and `exactOptionalPropertyTypes: true`; no `any` (lint error); no non-null assertions.
- Every external input is validated with Zod at the boundary.
- Errors use a typed `AppError` hierarchy with stable `code`s.
- Logging uses pino structured JSON; no secrets or PII in logs (redaction paths configured).
- Dates are ISO-8601 UTC; IDs are **UUIDv7** stored as `uuid`, plus human-friendly prefixed public IDs where shown (e.g. `run_01J…`, `fnd_…`).

---

## 6. Repository layout (create exactly this)
```
apps/
  web/                 Next.js console (+ BFF route handlers for auth)
  api/                 NestJS control-plane API (REST /v1 + GraphQL /graphql); Run Broker API under /internal/broker
  worker/              Temporal workers: run orchestration, validation, scheduler, retention, exports, connectors, notifications
  agent-runtime/       In-sandbox Claude Agent SDK host + in-process Blackwing MCP tool servers
  sandbox-controller/  Creates/destroys sandboxes (KubernetesDriver, DockerDriver), run networks, CA material
  model-gateway/       Anthropic-Messages-compatible gateway: auth (virtual keys), routing, redaction, cost metering & caps, pinning
  egress-gateway/      Go: scoped egress proxy (HTTP(S) MITM, SOCKS5, DNS), budgets, capture, kill, fail-closed
  session-manager/     Multi-role login/keep-alive/validity/lockout guard; injects sessions at the egress gateway
  cli/                 `blackwing` CLI (CI usage)
packages/
  contracts/  db/  domain/  policy/  agents/  mcp-tools/  memory/  replay/  oob/  evidence/  crypto/
  secrets/  audit/  notify/  connectors/  reporting/  cost/  config/  logger/  ids/  telemetry/  ui/  testing/
infra/
  tofu/  helm/  k3s/  docker/ (Dockerfiles; sandbox image)  compose/ (docker-compose.dev.yml)
eval/
  targets/  ground-truth/  harness/
docs/
  adr/  architecture/  runbooks/  api/  user/  labels.md (label catalogue)
design/               Claude Design export: UI source of truth for every GUI (design system, screens, tokens.json); see design/README.md
.github/ (workflows, ISSUE_TEMPLATE, PULL_REQUEST_TEMPLATE.md, CODEOWNERS, labels.yml)
CLAUDE.md  README.md  SECURITY.md  LICENSE (proprietary notice)
```

---

## 7. Core domain model (tables in `packages/db`; all tenant tables have `tenant_id uuid not null` + RLS)
- **tenants** (organisations): `id, slug, name, status(active|suspended|deleted), region, plan, created_at`. **users**: `id, keycloak_sub, email, name, status`. **memberships**: `tenant_id, user_id, roles[]`.
- **service_accounts** / **api_tokens**:
  - token: `bw_pat_…` / `bw_ci_…`, stored as a SHA-256 hash with prefix lookup;
  - scopes, plus an optional constraint: an `asset_ids[]` / `standing_authorisation_id` binding;
  - `expires_at`, `last_used_at`, `revoked_at`.
- **assets**:
  - `type(web_app|api|host|network_range|source_repo)`;
  - `identifiers` (hostnames/URLs/CIDRs/repo URL);
  - `environment(prod|staging|dev|test)`, `owner_user_id`;
  - `verification_status(unverified|pending|verified|rejected)`, `verification_method(dns_txt|http_file|manual_letter)`;
  - attestation (F6: env type, shared DB, shared login service/SSO, third-party hosting, lockout exemption, contacts).
- **asset_credentials**: `role_name`, `secret_ref` (never plaintext), login recipe, MFA type.
- **role_matrices**: roles × functions → expected access (F9).
- **standing_authorisations (SA)**:
  - `asset_ids`, `scope_rules` (include/exclude hosts, paths, ports, methods);
  - `max_intrusiveness`, `pre_approved_test_classes`, `default_budgets`;
  - `test_windows` (cron-like with timezone), `valid_from`, `expires_at`;
  - `requester_id`, `approver_id` (≠ requester), `signature` (JWS over the JCS-canonical body), `signing_key_id`;
  - `status(draft|pending_approval|active|expired|revoked)`, `revocation_reason`.
- **policies**: tenant Cedar policy sets, versioned (`version`, `sha256`, `author`, `active`); the platform **baseline policy** is non-overridable.
- **assessment_requests / runs**:
  - `mode(black|grey|white)`, `objective`, `asset_ids`, `sa_id`;
  - `input_manifest_id`, `state`, `state_version`;
  - `run_manifest` (pins), `budgets` (cost cap USD, max requests, max duration);
  - `requested_by`, `trigger(console|api|ci|schedule|retest)`, `created_at`, `started_at`, `ended_at`.
- **input_manifests**: supplied URLs/CIDRs, credentials refs per role, specs (OpenAPI/Postman/GraphQL SDL/HAR) object keys, source repo ref, config/deploy manifests, role matrix id.
- **test_plans** (versioned) → **test_cases**:
  - `class(intrusiveness)`, `title`, `owasp/wstg/asvs refs`, `cwe_candidates`;
  - `targets`, `roles`;
  - `budget(max_requests, max_rps, max_concurrency, max_bytes)`;
  - **`oracle`** (declared validation check: type + params);
  - `negative_control`;
  - `status(proposed|approved|removed|executing|executed|skipped|blocked|failed|model_declined|not_applicable)`, `status_reason`.
- **gate_decisions**: gate (1|2|3), subject, decision, actor, reason, `decided_at`, `timeout_at`, `auto` flag.
- **subtasks**: `test_case_id`, `persona`, `brief`, `session_id`, `sandbox_id`, `status`, `result`, `cost`.
- **agent_sessions**: `persona`, `persona_version`, `prompt_sha256`, `model`, `effort`, `sdk_version`, `claude_code_version`, `session_id`, `sandbox_id`, `status`, `num_turns`, `total_cost_usd`, `model_usage jsonb`, transcript object key.
- **findings**:
  - `fingerprint`, `title`, `class`, `cwe_id`, `owasp_category`;
  - `severity` (CVSS v4.0 vector + score, with a 3.1 vector optional);
  - `asset_id`, `location` (method, URL template, parameter, file:line for white box);
  - `status` (lifecycle above), `baseline_status`;
  - `run_id`, `first_seen_run_id`, `last_seen_run_id`;
  - `confidence`, `released_by`, `released_at`.
- **finding_occurrences** (per run).
- **evidence_items**: `kind(request|response|har|pcap|screenshot|dom|replay_script|oob_interaction|transcript_excerpt|log)`, `object_key`, `sha256`, `size`, `content_type`, `captured_at`, `chain` (prev hash), `retention_until`, `legal_hold`.
- **repro_artifacts**: bundle key + sha256 + format version.
- **coverage_manifests**: per run; immutable once finalised; required for export.
- **reversal_journal_entries**: `test_case_id`, `action`, `target`, `undo_instructions`, `undo_status(pending|undone|not_needed|failed)`, `created_at`.
- **oob_correlations**: `token`, `run_id`, `test_case_id`, `expires_at`; **oob_interactions**.
- **audit_events**: append-only hash chain per tenant.
- **connectors**, **ticket_links**, **notification_channels**, **schedules**, **blackout_windows**, **retention_policies**, **cost_ledger**, **price_tables** (versioned), **kill_events** (halt timings), **eval_runs**.

Rules:
- Every table has `created_at`/`updated_at`, uses soft-delete only where stated, and puts foreign keys and indexes on all lookup columns.
- **RLS policy:** `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. The app DB role has no `BYPASSRLS`, and migrations run as a separate owner role.
- Every request sets `app.tenant_id` with `SET LOCAL` inside a transaction (`withTenant(tx, tenantId, fn)` helper). A request without a tenant context **fails closed**.

---

## 8. Security invariants (every issue must preserve these; tests must prove the ones they touch)
1. **No target traffic without a valid, unexpired, signature-verified envelope.** The egress gateway re-verifies on load and on every policy refresh; expiry mid-run ⇒ immediate block.
2. **Egress fails closed:**
   - if the gateway cannot evaluate policy, reach its config or write capture, it blocks;
   - redirects and DNS answers to out-of-scope destinations are blocked (anti-rebinding: resolve once, pin IP, re-check);
   - private/link-local/metadata ranges are blocked unless explicitly in scope.
3. **Destructive class is never allowed.** `state_changing` requires an SA + Gate 1 approval and a prior reversal-journal entry.
4. **Separation of duties:** requester ≠ approver for SA, Gate 1 and Gate 2. Enforcement happens in service code + Cedar + DB check constraint/trigger.
5. **Kill switch:**
   - one action stops every agent in scope (run/asset/tenant/global);
   - the egress gateway blocks first (target: < 2 s p99), then sandboxes are terminated (< 10 s p99), virtual model keys are revoked and Temporal workflows are cancelled;
   - halt time is measured, shown and audited.
6. **Tenant isolation everywhere:** DB RLS, Neo4j tenantId guard, S3 prefixes + per-tenant encryption context, Valkey key prefixes, per-run sandboxes, per-tenant memory (no cross-tenant retrieval). Cross-tenant access tests are mandatory for every data-access module.
7. **Secrets never reach the model, the logs or the sandbox in plaintext.**
   - Credentials are used by reference: the session manager and egress gateway inject them.
   - Known secret values are redacted from tool output before it reaches the model (PostToolUse) and in the model gateway.
8. **Audit ledger is append-only and tamper-evident.** Every login, approval, gate decision, tool action, finding release, export, kill and config change writes an event.
9. **Pinned versions:** every run records model IDs, persona/prompt versions + hashes, SDK + Claude Code versions, sandbox image digest, tool versions, nuclei template commit, policy hash, envelope hash and price table version. Runs never silently float.
10. **Ownership verification:** an unverified asset can never be targeted (SaaS abuse prevention).
11. **No model-dependent safety:** every safety property is enforced by deterministic code.

---

## 9. API conventions
- REST base `/v1`, JSON, camelCase.
- Errors use RFC 9457 problem+json: `type`, `title`, `status`, `detail`, `code`, `traceId`.
- Pagination is cursor-based (`?cursor=&limit=`, max 200).
- `Idempotency-Key` header is required on POST that creates runs/exports/tickets.
- Optimistic concurrency via `If-Match`/ETag on mutable resources.
- Rate limits per token (429 + `Retry-After`).
- Authn: session cookie (console via BFF) or `Authorization: Bearer bw_pat_/bw_ci_`.
- Authz: RBAC permission check + Cedar resource check.
- Every endpoint is in the OpenAPI spec, with examples and error codes.
- GraphQL is read-optimised for console dashboards, with persisted queries in prod, depth/complexity limits and DataLoader batching.
- Internal **Run Broker API** (`/internal/broker/*`) is only reachable from the sandbox network, uses run-scoped tokens and covers tool backends: submit candidate, record evidence metadata, journal, state reads.

---

## 10. Development environment & workflow
- **Development host:** an **AWS EC2 instance** (Ubuntu 24.04 LTS, ≥ 8 vCPU / 32 GB RAM / 200 GB gp3 recommended) running Docker Engine + `runsc`, Node 22, pnpm, Go, OpenTofu, kubectl/helm, k3s (single node) and Claude Code (developer's own subscription is fine for *building*).
- `pnpm dev:deps` starts `infra/compose/docker-compose.dev.yml`: postgres(+pgvector), valkey, neo4j, temporal (+ui), keycloak (realm import), openbao (dev), minio (object lock), mailpit, interactsh (local), otel-collector, grafana stack (profile `obs`).
- `pnpm dev` runs apps with hot reload. `pnpm test`, `pnpm test:int` (Testcontainers), `pnpm test:e2e` (Playwright against compose stack + a local Juice Shop target).
- Seed data: `pnpm db:seed` creates demo tenant `acme`, users per role (password login only in dev), a verified demo asset pointing to the local Juice Shop, an active SA, and a role matrix.
- Branch per issue (`<key>-<slug>`, e.g. `egress-004-request-budgets`), Conventional Commits, PR closes the issue (`Closes #N`); PR template includes the acceptance-criteria checklist copied from the issue.

### Definition of Done (applies to every issue)
- [ ] All acceptance criteria met and demonstrably tested (unit + integration where IO is involved; e2e for user-visible flows).
- [ ] Edge cases listed in the issue have explicit tests.
- [ ] Lint/typecheck/tests green in CI; no `any`, no skipped tests, no TODOs without a linked issue.
- [ ] Tenant isolation, authz and audit events covered where the change touches data or actions.
- [ ] OpenAPI/GraphQL schema, Zod contracts, migrations and docs updated in the same PR.
- [ ] Observability: structured logs, metrics and traces for new paths; no secrets in logs.
- [ ] Security invariants (§8) preserved; threat considerations noted in the PR.

---

## 11. Issue-writing standard (for generators)
- **One issue = one PR-sized unit** a Claude Code session can complete in one sitting (≈ 0.5–2 days of work). Split anything bigger; never mix unrelated concerns.
- **Title format:** imperative and specific, e.g. `Enforce per-test-case request budgets in the egress gateway`. The creation script adds the key prefix `[EGRESS-004]`.
- **Body sections, in order (Markdown):**
  1. `## Summary`: 2–4 sentences on what and why.
  2. `## Context`: where it sits in the architecture, related features (F-ids), personas, and the exact relevant decisions copied from this pack (stack, paths, names) so the issue stands alone.
  3. `## Scope`: **In scope** bullets / **Out of scope** bullets (point to the issue keys that own them).
  4. `## Detailed requirements`: numbered, testable statements. Include exact names:
     - file paths;
     - module/class/function names;
     - DB tables/columns with types;
     - API routes with request/response shapes (TypeScript/Zod snippets welcome);
     - event names;
     - config keys with defaults;
     - error codes;
     - UI routes/components.
  5. `## Acceptance criteria`: `- [ ]` checklist; each item objectively verifiable (command, test name or observable behaviour).
  6. `## Edge cases & failure modes`: an exhaustive bullet list with the required behaviour for each. Cover:
     - null/empty/oversized input, unicode, timezones/DST;
     - concurrency/races, retries/idempotency, partial failure, timeouts;
     - permission denied, cross-tenant access attempts;
     - expired/revoked authorisation, kill switch during the operation;
     - downstream outage, malformed upstream data, and so on, as relevant.
  7. `## Security, privacy & audit`: threats, authz rules, audit events emitted, redaction.
  8. `## Observability`: logs, metrics (names), traces/spans.
  9. `## Test plan`: unit/integration/e2e cases, named.
  10. `## Dependencies`: `Blocked by:` issue **keys** (e.g. `DB-003`); `Related:` keys.
  11. `## Implementation notes for Claude Code`: suggested steps, commands to run, pitfalls, files to read first.
- Metadata per issue (JSON fields, not in body):
  - `key`, `title`, `type`, `priority` (P0 = needed for the first end-to-end grey-box run; P1 = v1 must-have; P2 = v1 should-have; P3 = nice-to-have/Later);
  - `size` (XS < 2h, S ≤ 0.5d, M ≤ 1d, L ≤ 2d; **no XL**: split it);
  - `milestone`, `labels`, `features`, `depends_on`.
- Be concrete and decisive. Do not write "consider X or Y": pick one, per this pack. Never contradict §5 or §8.
