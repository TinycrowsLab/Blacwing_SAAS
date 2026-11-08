# AI hunt POC: build spec

Goal: a working demo where Claude (Agent SDK) orchestrates a team of agents that hunt real bugs on **any registered URL target**, under the
human gates in the architecture, with every finding proved by a **deterministic validator**. Juice Shop is only a test target. Nothing
target-specific may be hardcoded (no paths, parameters, payload strings, ports or product names of a target).

We build on the existing `demo` stack (`scripts/demo.mjs`, `apps/api/src/demo`, `apps/worker/src/demo`, `apps/web/src/app/demo`,
schema `demo`). Keep its auth hop (`x-bw-demo-*` headers + internal token), Gate 1 separation of duties, `DemoRefusal` problem+json,
`afterSeq` polling and report rendering. Delete what becomes dead (the pinned SQLi catalogue, `replay.ts` pinned case, fallback seed story).
Code must be simple and small: no speculative abstractions, no unused exports, strict TS, zod at boundaries, no `any`.

## Safety rules (architecture, deterministic, never model-dependent)

| Rule | Enforcement point |
|---|---|
| Asset must be **ownership-verified** before a request | API `createRequest` |
| Gate 1: requester (appsec-engineer) ≠ approver (asset-owner) | API + DB check (existing) |
| Every target request is checked against the run scope: scheme+host+port in `asset.allowedOrigins`, path not under `excludedPaths` | worker `http_request` tool, before any I/O |
| Out of scope → refused, event `policy.blocked`, never sent | worker |
| Method class: `GET/HEAD/OPTIONS` = `active_safe` (allowed). `POST/PUT/PATCH` = `state_changing` → **Gate 2**. `DELETE`, `TRACE`, `CONNECT` = `destructive` → always refused | worker |
| Gate 2: a human decides within the countdown (default `BW_GATE2_TIMEOUT_S`=300). **No decision = denied.** Approval covers that `METHOD + path` (no query) for the rest of the run | worker blocks the tool call; API decides |
| Request budget, duration budget, cost cap (`maxBudgetUsd`) | worker |
| Kill: run halts, agent aborted, pending Gate 2 denied, measured halt time recorded | API sets flag, worker polls every 500 ms |
| A finding is written as `confirmed` **only** if the validator replays the probe 3× with the oracle matching every time and the negative control not matching. The model never decides confirmation | worker validator |
| Redirects are not followed (`redirect: 'manual'`); request timeout 10 s; response body returned to the model truncated to 8 KB | worker |
| Agents get no shell, file, web-search or web-fetch tools; only the `blackwing` MCP tools and the `Agent` tool | worker `allowedTools`/`disallowedTools`, `settingSources: []` |

## 1. Database: new migration `packages/db/migrations/20261105000000_demo_ai_hunt.sql`

Follow the style of `20261029200000_demo_story_schema.sql` (statement breakpoints, `bw_app` grants incl. new tables, no DELETE grant).
Also register it however the migration journal requires (check `packages/db/migrations/meta`).

- `demo.assets`: add `allowed_origins text[] NOT NULL DEFAULT '{}'` (e.g. `{https://shop.example.com,https://api.example.com:8443}`),
  `excluded_paths text[] NOT NULL DEFAULT '{}'`, `verification_token text`, `verified_by uuid`, `verified_at timestamptz`, `created_by uuid`.
  Drop the old `verification_method` check if any; allowed values now `http_token | owner_attestation`.
- `demo.assessment_requests`: make `test_case_id` nullable; add `objective text NOT NULL DEFAULT ''`, `cost_cap_usd numeric(8,2) NOT NULL DEFAULT 5`.
  Keep intrusiveness check (`passive|active_safe`) — the request ceiling stays active_safe; state-changing is per action via Gate 2.
- `demo.runs`: extend `state` check to `queued|running|paused|completed|failed|killed`; add `kill_requested_at timestamptz`,
  `kill_requested_by uuid`, `killed_at timestamptz`, `halt_ms int`, `paused boolean NOT NULL DEFAULT false`, `cost_usd numeric(10,4) NOT NULL DEFAULT 0`,
  `summary text`.
- `demo.findings`: make `test_case_id` nullable; extend status check to `confirmed|suspected|not_confirmed`; add `agent text`, `description text`.
- New `demo.http_exchanges(id uuid pk, tenant_id, run_id → runs, seq int, agent text, method, url, request_headers jsonb, request_body text,
  status int, response_headers jsonb, response_body text (store max 64 KB), duration_ms int, outcome text check in ('sent','blocked','denied','error'),
  reason text, at timestamptz default now())`, index `(run_id, seq)`.
- New `demo.gate2_requests(id uuid pk, tenant_id, run_id → runs, agent text, method text, url text, path_key text, intrusiveness text,
  reason text (agent's reason, unverified), why_outside text, status text check in ('pending','approved','denied','expired'), deadline_at timestamptz,
  decided_by uuid, decided_at timestamptz, created_at default now())`.

## 2. Event model (`demo.run_events`, unchanged table)

`kind` values written by the worker (the UI maps these; `data` shapes are fixed):

| kind | stage | data |
|---|---|---|
| `run.queued` (API) | `queued` | `{}` |
| `run.started` | `plan` | `{model, agents: string[]}` |
| `agent.message` | agent name | `{agent, text}` — assistant text, labelled "not verified" in UI |
| `agent.tool` | agent name | `{agent, tool, input}` (non-http tool calls incl. `Agent` delegations: `{subagent, description}`) |
| `agent.turn` | agent name | `{agent, turns, costUsd}` running per-agent totals (emit after each assistant message; UI keeps latest) |
| `http.sent` | agent | `{agent, exchangeId, method, url, status, bytes, ms}` |
| `policy.blocked` | `policy` | `{agent, method, url, rule}` (out of scope / destructive / budget) |
| `gate2.requested` | `gate2` | `{agent, gate2Id, method, url, deadlineAt}` |
| `gate2.decided` | `gate2` | `{gate2Id, status, by?}` |
| `candidate.submitted` | `validator` | `{agent, candidateId, title, severity}` |
| `validator.replay` | `validator` | `{candidateId, n, status, matched}` |
| `validator.control` | `validator` | `{candidateId, status, matched}` |
| `finding.confirmed` / `finding.not_confirmed` | `validator` | `{candidateId, findingId?, title, severity}` |
| `run.paused` / `run.resumed` | `control` | `{by}` |
| `run.killed` | `control` | `{by, haltMs}` |
| `run.completed` / `run.failed` | `done` | `{requestsUsed, costUsd, findings, reason?}` |

Agent names (lanes): `orchestrator`, `recon`, `web-api-specialist`, `authz-specialist`, `validator`. `policy` events are shown in the activity
feed. Per-run `seq` allocation must be safe for concurrent writers in one process (serialize appends per run in the worker).

## 3. API (`apps/api/src/demo`, base `/v1/demo`)

Remove `catalogue.ts` test-case pinning, `LOOPBACK_HOSTS`, `BW_TARGET_JUICE_SHOP_URL`, the juice-shop seed asset and fallback story (seed keeps
only what is needed: nothing target-specific). Routes (zod strict bodies, existing actor/role pattern):

| Route | Role | Notes |
|---|---|---|
| `GET /dashboard` | any | counts + recent assets, requests, runs, findings (multiple) + `pendingGate2[]` |
| `GET /assets`, `GET /assets/:id` | any | asset DTO incl. `allowedOrigins`, `excludedPaths`, `ownership{status, method, verifiedBy, verifiedAt}`, `verification{token, wellKnownUrl}` |
| `POST /assets` | appsec-engineer | `{name, baseUrl (http/https URL), extraOrigins?: string[], excludedPaths?: string[]}` → unverified, `verification_token` = random 32 hex; `allowed_origins` = origin(baseUrl) + extraOrigins |
| `POST /assets/:id/verify` | asset-owner | `{method:'http_token'}` fetches `<baseUrl origin>/.well-known/blackwing-verification.txt` (no redirects, 5 s) and requires it to contain the token; or `{method:'owner_attestation', statement: string(min 10)}` = the asset owner attests authority (lab / owned system). Records `verified_by/at` |
| `POST /requests` | appsec-engineer | `{assetId, objective (1..2000 chars), intrusiveness:'passive'\|'active_safe', budgetRequests 10..5000, budgetSeconds 60..7200, costCapUsd 0.5..100, excludedPaths?: string[]}`; asset must be verified |
| `GET /requests/:id`, `POST /requests/:id/decision`, `POST /requests/:id/runs` | as today | `pins` = `{asset:{id,name,baseUrl,allowedOrigins,excludedPaths(asset ∪ request)}, request:{id, objective, intrusiveness, budget:{requests,seconds,costUsd}, requesterId, approverId, decidedAt}, authorisation:{saId:'SA-'+first 8 of request id upper, signedBy: approver name, keyId:'bw-demo-key'}, runner:{name:'ai-hunt', version:'1'}}` |
| `GET /runs/:id?afterSeq=N` | any | run DTO (incl. `state, paused, costUsd, requestsUsed, budget, startedAt, finishedAt, haltMs, summary, pins`) + `events[]` (afterSeq) + `lastSeq` + `findings[]` (all, summary fields) + `gate2[]` (all for run) + `stats{httpSent, blocked, gate2Pending}` |
| `GET /runs/:id/exchanges?afterSeq=N` | any | http exchange list (excerpt bodies ≤ 2 KB) |
| `POST /runs/:id/pause`, `POST /runs/:id/resume` | appsec-engineer or asset-owner | sets `paused`, appends event |
| `POST /runs/:id/kill` | any authenticated tenant user | `{scope:'run', confirm: string}`; `confirm` must equal the run's short id (first 8 chars of run id, case-insensitive) → sets `kill_requested_at/by`; returns `{killRequestedAt}`. Worker finalises (`state=killed`, `killed_at`, `halt_ms`). If run is queued: kill immediately in API |
| `POST /kill` | any authenticated tenant user | Blast radius wider than one run: `{scope:'target', assetId, confirm}` (confirm = the target's name) or `{scope:'workspace', confirm}` (confirm = the workspace name, or `STOP ALL` while unnamed), case-insensitive. Each live run in scope goes through the per-run kill path (queued: killed here; running/paused: flagged, the worker measures `halt_ms`). Ledger: one `run.kill` per run, then one `kill.scope` `{scope, runs, runIds}`. Returns `{scope, killRequestedAt, runs:[{id, assetId, assetName, killRequestedAt}], audit}`; 409 `run_not_running` when nothing in scope is live |
| `GET /gate2/:id` | any | gate2 DTO incl. run summary, `deadlineAt`, `secondsLeft` |
| `POST /gate2/:id/decision` | asset-owner or appsec-engineer, not `kill`ed run | `{decision:'approve'\|'deny'}` only while `pending` and before deadline; else 409 `gate2_closed` |
| `GET /findings`, `GET /findings/:id`, `GET /findings/:id/report?format=html\|md` | any | report generalised to the new evidence shape (below); no target-specific copy |

Finding `evidence` jsonb shape (written by worker): `{probe:{request:{method,url,headers,body}, response:{status, bodyExcerpt, bodySha256}}, control:{same},
oracle:{type,value}, replays:[{n,status,matched,bodySha256}], description}`; `repro_curl` built from the probe.

## 4. Worker hunt engine (`apps/worker/src/demo/`)

Replace the pinned runner. Files: `main.ts` (poll loop, up to `BW_HUNT_CONCURRENCY`=2 concurrent runs), `store-pg.ts`, `hunt/scope.ts`,
`hunt/http-tool.ts`, `hunt/validator.ts`, `hunt/prompts.ts`, `hunt/orchestrator.ts`. Add `@anthropic-ai/claude-agent-sdk` (`catalog:`), and move
`pg`, `@blackwing/ids` to dependencies.

- Claude auth (CLAUDE.md: a Claude.ai subscription login must never power customer runs): if `ANTHROPIC_API_KEY` is set it is used. Otherwise
  the host's Claude login (`~/.claude`) is used **only** when `BW_ENV=dev` (local demo); in any other env a run without an API key fails
  with `run.failed{reason:'model_credentials_missing'}`. Pass `env` with `HOME`, `PATH`, and `ANTHROPIC_*` only. Model: `BW_HUNT_MODEL` (default `claude-sonnet-5-5`), subagents `model:'inherit'`.
  Mark with `OFFLINE-STUB(online-porting): direct SDK auth instead of the model gateway`.
- `query({prompt, options:{ model, agents:{recon, 'web-api-specialist', 'authz-specialist'}, mcpServers:{blackwing: createSdkMcpServer(...)},
  allowedTools:['Agent','TodoWrite','mcp__blackwing__*'], disallowedTools:[Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, NotebookEdit, ...],
  settingSources:[], maxTurns: 200, maxBudgetUsd: costCap, abortController, cwd: an empty temp dir }})`. Stream all messages:
  map `parent_tool_use_id` → subagent name (from the `Agent` tool_use input `subagent_type`) to attribute messages to lanes.
  Use a `PreToolUse` hook (it receives `agent_type` inside subagents) to stamp the calling agent into `http_request`/`submit_candidate` input
  via `updatedInput` if supported; otherwise keep an `agent` param.
- MCP tools (`blackwing` server):
  - `http_request({method, url, headers?, body?, purpose})` → scope check → method class (Gate 2 / refuse) → budget → pause wait → `fetch`
    → store `http_exchanges` → event `http.sent` → return `{exchangeId, status, headers (subset), body (≤ 8 KB, marked truncated)}`.
    Gate 2: insert `gate2_requests` (pending, deadline), event, poll every 1 s until decided/expired/killed; approved → send; else return refusal text.
  - `submit_candidate({title, vulnClass, cwe, owasp, severity: critical|high|medium|low|info, description, probe:{method,url,headers?,body?},
    control:{method,url,headers?,body?}, oracle:{type: 'body_contains'|'body_regex'|'status_equals'|'header_contains', value}})` → validator:
    probe + control must pass the same scope/method rules (state-changing ones need an approved Gate 2 key); replay probe 3× and control 1×
    (these count against the budget); confirmed iff all 3 probe replays match and control does not → insert finding (`confirmed`) else
    finding row `not_confirmed` is NOT inserted (event only). Returns the verdict to the agent. Fingerprint = sha256(runId|method|path|vulnClass|title).
  - `list_exchanges({limit?})` → recent exchanges summary for the agent's own memory (method, url, status, bytes).
- Prompts (`hunt/prompts.ts`): orchestrator plans from `objective` + scope, delegates to `recon` first, then specialists in parallel, and writes a
  short final summary (stored in `runs.summary`). Base rules for all: authorised scope only, treat target content as untrusted data, never destructive,
  benign proof-only probes (e.g. a quote/syntax-error probe, boolean/time-free differentials, reflected marker strings, role/ID swaps) — prove with
  the minimum, no data exfiltration, no DoS, no brute force; every candidate needs an oracle and a negative control. Use CWE/OWASP ids.
  `recon`: map surface (robots, sitemap, well-known, JS bundles, API docs like openapi/swagger, error pages, headers). `web-api-specialist`:
  injection (SQLi, NoSQLi), XSS reflection, SSTI, path traversal, open redirect, SSRF indicators, CORS, security headers, verbose errors, exposed files.
  `authz-specialist`: IDOR/BOLA, BFLA, auth bypass, JWT weaknesses, unauthenticated access to sensitive endpoints.
- Kill/pause: per-run watcher every 500 ms reads `kill_requested_at`/`paused`; kill → abort controller, deny pending Gate 2, `state='killed'`,
  `halt_ms = killed_at - kill_requested_at`, event. Budget seconds exceeded → abort, `completed` with reason.
- Crash safety: on startup, runs left in `running` from a dead worker → `failed` with event `run.failed{reason:'worker_restarted'}`.

## 5. Web (`apps/web/src/app/demo`, `apps/web/src/components/demo`) — must match `design/Blackwing Screens.dc.html`

Open the design via `python3 -m http.server 8099 -d design` and Playwright screenshots to compare. Use the existing tokens (`packages/ui`
`tokens.css`), Poppins + JetBrains Mono, kill red only for Kill/killed/logo, navy for actions/running, status `ok/warn/bad`, severity chips.

- Shell (all demo pages): top bar (logo + "Blackwing", tenant chip, search box with Ctrl K, bell with pending Gate 2 count, red **Kill** button
  → kill dialog for the most recent running run (or disabled), avatar initials); left icon rail (dashboard, assets, findings, runs/terminal,
  approvals, …). Remove the "Lab target only (local Juice Shop)" banner and all Juice Shop copy.
- Dashboard `/demo`: stat cards, running runs, waiting on you (Gate 1 + Gate 2), recent findings.
- Assets `/demo/assets`: list + **Register target** form (name, base URL, extra origins, excluded paths) + per asset verification panel
  (shows the well-known URL + token, "Verify via HTTP token" and "Attest ownership" for asset-owner).
- New assessment `/demo/requests/new`: verified asset select, objective textarea (prefilled generic "Black-box web assessment: OWASP Top 10 …"),
  intrusiveness (max active-safe; state-changing explained as Gate 2), budgets (requests, minutes, cost cap), extra excluded paths.
- Request `/demo/requests/[id]`: Gate 1 card (approve/reject by second user), start run.
- Run `/demo/runs/[id]` — **Flight deck (1a)** with a **Transcript (1b)** tab:
  breadcrumb `Assessments / run_<id8>`, title = asset name, mode chip "Black box", status chip; buttons Pause run / Resume, Run manifest
  (dialog with pins JSON), **Kill run**. Gate 2 banner when pending (countdown mm:ss, Review → Gate 2 page). Authorisation strip
  (Authorised under SA-…, signed by, key; Scope origins; Window = now→+budget; Max intrusiveness; Expires). Four gauges (Elapsed clock, Model
  cost vs cap, Requests vs budget, Duration %). **Agent team** lanes: one row per agent (name, turns, cost, current task text = last message),
  SVG time axis of the last 2 minutes with marks (● http, ■ tool, ○ blocked, ◆ candidate/finding), paused lane hatched. **Activity** table with
  filters (All agents / HTTP / Policy / Errors only). Right column: **Test cases**-style progress (HTTP sent / blocked / candidates / confirmed)
  and **Candidate findings** list with severity chips and status (Confirmed / Validating / Not confirmed) → finding page.
  Transcript tab: chat-like agent messages (agent name, time, text labelled "not verified"), HTTP request chips inline (method path status ms),
  inline Gate 2 card with countdown + Deny / Approve once, bottom control bar (Pause, cost/requests/duration bars, "Controls only. No free-text steering.").
  Poll `/demo/api/runs/[id]?afterSeq` every 1.5 s until terminal.
- Gate 2 `/demo/approvals/gate2/[id]` (2a, responsive for 2b mobile): large countdown ring "Auto-deny in mm:ss of mm:ss allowed", action
  (METHOD path, host, run), Intrusiveness (State-changing), Environment, Reversal ("Journal entry ready" not applicable → show "Not recorded"),
  "Why this is outside the authorisation" (rules), "Reason given by the agent (not verified)", Deny (primary dark) / Approve once.
- Kill dialog (3a): blast-radius nested rings (run selected; asset/org/global shown disabled for the POC), typed confirmation of the run short id,
  then measured halt progress (agent aborted, Gate 2 denied, egress blocked) and the audit event with halt ms.
- Findings `/demo/findings/[id]`: title, severity, CWE/OWASP, agent, description (not verified), oracle, probe vs negative control, 3 replays,
  repro curl, HTML/MD report download.
- Server actions + route handlers for all new API calls (same `demoApi` pattern). `schemas.ts` updated to the new DTOs.

## 6. Launcher `scripts/demo.mjs`

Remove the Juice Shop step from `up` and smoke. Add `node scripts/demo.mjs lab` (optional helper that starts any lab container, default Juice
Shop on 127.0.0.1:3001 — the only place its name appears). Start `demo-runner` = `tsx src/demo/main.ts` (hunt engine). Support `DEMO_HOST=0.0.0.0`
and `DEMO_PUBLIC_ORIGIN` (e.g. `http://<ec2-ip>:3000`) for EC2: set `BW_CONSOLE_ORIGIN`/`WEB_ORIGIN` from it and print the Keycloak redirect URI
to add. Smoke: takes the target from `DEMO_SMOKE_TARGET` (required for smoke), registers it, attests ownership, Gate 1, starts a short run
(budget 60 requests, 5 min, $2) and checks it reaches a terminal state with events from ≥2 agents.
