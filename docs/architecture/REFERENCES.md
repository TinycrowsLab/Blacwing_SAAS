# Blackwing REFERENCES: prior art, patterns, SDK facts & standards

> **What this file is.** A grounding catalogue for issue-authors writing GitHub issues for **Blackwing** (authorised, human-gated autonomous security-assessment SaaS; agent runtime = Claude Code / Claude Agent SDK). It maps established open-source prior art, agent-orchestration patterns, Claude Agent SDK facts, the MCP ecosystem, the open-source security toolchain, and the standards/data sources every issue should cite — onto the Blackwing architecture in `CONTEXT_PACK.md` (personas §4.6, stack §5, domain §7, invariants §8).
>
> **How to use it.** Cite names by identifier in issues (standard IDs, repo names, pattern names, persona template). This file is *prior art and vocabulary*, not an implementation spec — where it and `CONTEXT_PACK.md` disagree, the pack wins.
>
> **Altitude rule (mandatory, mirrors AUTHOR_BRIEF §"Content safety & altitude").** Everything here is at engineering/functional altitude: capabilities, architecture patterns, tool *purposes*, standards *by identifier*. **No exploit payloads, no step-by-step attack walkthroughs, no bypass recipes.** Verified against official sources on 2026-10-19.

---

## 1. Prior-art autonomous / AI pentest & security-agent projects

Study these for *architecture ideas* (task decomposition, tool use, memory, validation) — **not** code to copy. Per `CONTEXT_PACK §1.1`, Blackwing is built from scratch and **does not use PentAGI**; the entry below is for architectural comparison only.

| Project (repo) | What it is | What Blackwing should borrow / how issues use it |
|---|---|---|
| **PentAGI** (`vxcontrol/pentagi`, MIT) | Open-source autonomous pentest system: an orchestrator coordinating researcher / developer / executor specialists in sandboxed Docker; work modelled as flows→tasks→subtasks→actions; per-agent long-term vector + episodic memory on Postgres/pgvector; multi-provider LLM backends. | The **flows→tasks→subtasks→actions** decomposition and orchestrator↔specialist split validate Blackwing's Orchestrator + sub-planner + specialist model. **Do not adopt it as a dependency** (`§1.1`). Borrow the *shape* only; Blackwing replaces its Docker sandbox with gVisor per-session sandboxes and its free-for-all egress with the scoped gateway. |
| **CAI — Cybersecurity AI** (`aliasrobotics/cai`, pip `cai-framework`) | Lightweight open framework for building offensive/defensive security agents; specialized agents with **handoff** between them; 300+ model backends; built-in recon/exploitation tool wrappers; paper *"CAI: An Open, Bug Bounty-Ready Cybersecurity AI"* (arXiv 2504.06017). | The **agent-handoff** primitive maps to Blackwing's `dispatch_subtask` + Orchestrator delegation. Borrow the idea that specialists are narrow and composable; cite as prior art that specialized-agent pipelines are a recognised pattern. (Confirm its LICENSE before quoting terms — metadata is inconsistent.) |
| **HackingBuddyGPT** (`ipa-lab/hackingBuddyGPT`, TU Wien) | Minimal framework ("agent in ~50 lines"); `UseCase` base class + connection handlers (SSH/local); Linux priv-esc and web use cases; priv-esc benchmark set; paper *"Getting pwn'd by AI"* (arXiv 2310.11409). | Borrow the **benchmark/eval mindset** (reusable scored scenarios) for Blackwing's `eval/` harness (F40). Its blunt "LLM emits shell commands, framework runs them" loop is exactly what Blackwing constrains — contrast it in issues to motivate the PDP hook + egress gateway. Use the *official* ipa-lab repo (forks carry scam text). |
| **Strix** (`usestrix/strix`, Apache-2.0) | Autonomous security-testing agents that run code dynamically, find vulns, and **validate them with real PoCs**; HTTP-proxy request/response manipulation, browser automation, terminal + Python exploit sandbox; reports link to the exact PoC; CI/CD integration. | Strongest validation prior art: **"prove it with a reproducing PoC, report the PoC."** Directly supports Blackwing's Validator + standalone repro artifact (F14, F18) and Confirmed-vs-Suspected split (F17). Its proxy/browser/terminal tool surface mirrors Blackwing's `http_request` / Playwright / Bash specialist tools. |
| **Vulnhuntr** (`protectai/vulnhuntr`) | Python static analyzer that uses Claude to trace **source→sink** call chains across chunked code (to fit context), emitting reasoning + **confidence score** + PoC; found 0-days in Langflow/FastChat/LLaVA; explicitly non-deterministic (different results per run) and cost-sensitive. | Borrow **source→sink call-chain tracing** for the `code-specialist` persona (white-box), and the **confidence-score → triage-threshold** idea for finding `confidence`. Its own caveat — *LLM results are non-deterministic* — is the entire reason Blackwing requires a **deterministic replay validator** (F14, `packages/replay`). Cite it when an issue justifies deterministic confirmation. |
| **Nebula** (`berylliumsec/nebula`, pip `nebula-ai`) | CLI "AI layer around existing scanners" — recon support, note-taking, smart analysis of external tool output (e.g. nmap); local-model friendly (Ollama); explicit disclaimer that output may be inaccurate and commands should be reviewed before running. | Validates the **"AI wraps real tools, human reviews before execution"** posture. Supports Blackwing's design where specialists *call* vetted tools (subfinder/httpx/nuclei…) rather than invent commands, and where Gate 1/Gate 2 keep a human in the loop. |
| **Villager** (Cyberspike, PyPI `villager`) | China-origin AI pentest framework; **MCP client** wiring Kali toolsets + LangChain + DeepSeek; spins up ephemeral Kali containers (auto-destroyed ~24h). Flagged by researchers (Straiker) as dual-use/abuse-prone ("Cobalt-Strike trajectory"), with RAT-adjacent plugins in the wider suite. | Two lessons: (1) the **MCP-client-driving-toolsets** pattern is now standard — Blackwing uses in-process SDK MCP tools instead; (2) it is the **abuse cautionary tale** that justifies Blackwing's authorisation gates, ownership verification (§8.10), scoped egress, and kill switch. Cite when an issue motivates abuse-prevention controls. **Do not install or run it.** |
| **PentestGPT** (`GreyDGL/PentestGPT`; Deng et al., USENIX Security '24, arXiv 2308.06782) | Interactive LLM pentest assistant structured as **Reasoning / Generation / Parsing** modules around a **Pentesting Task Tree (PTT)** — an attributed tree (derived from attack trees) rendered to natural language to keep the model oriented and mitigate context loss. | The **PTT** is the canonical citation for Blackwing's test-plan/subtask tree and the "shared task listing" (§8 below). Its documented failure modes (context loss, recency bias, hallucinated commands in long sessions) justify Blackwing's deterministic Run Controller, step ceilings (`maxTurns`), and mentor/reflector personas. |

*Other current context (cite sparingly, verify before quoting):* academic benchmarks like **PentestEval** (arXiv 2512.14233) and surveys such as *"Hackers or Hallucinators?"* (arXiv 2604.05719) catalogue LLM-pentest capability and over-claiming — useful when an issue needs to justify the eval harness (F40) or the refusal/false-positive tracking.

---

## 2. LLM agent orchestration patterns → Blackwing mechanisms

Each pattern below has published prior art; map it to a Blackwing persona or deterministic mechanism so issues use the right vocabulary.

| Pattern (origin) | One-line | Blackwing mapping |
|---|---|---|
| **Orchestrator–worker** (Anthropic, *Building Effective Agents*, 2024; *multi-agent research system*, 2025) | A lead agent decomposes a goal and dispatches subtasks to workers, then synthesises. | The **Orchestrator** persona (`§4.6`) + `dispatch_subtask` → Run Controller starts a **specialist session in a new sandbox** (`§4.2`). "LLMs decide; code enforces." |
| **Planner / sub-planner** (classic hierarchical planning; LangChain *plan-and-execute*) | Separate the agent that makes the plan from the agent(s) that execute steps. | **planner** (surface model → test cases, structured output) and **sub-planner** (test case → subtasks, JSON-schema output) personas (`§4.2`, `§4.6`). |
| **ReAct** (Yao et al., 2022/23) | Interleave reasoning traces with tool actions and observations in a loop. | The native agent loop of every specialist Claude Code session: think → call a Blackwing MCP/Bash tool → observe gateway-captured response → continue, bounded by `maxTurns`. |
| **Reflexion / self-reflection** (Shinn et al., 2023) | An actor acts, an evaluator scores, a self-reflection step writes verbal feedback to memory to improve the next attempt. | The **reflector** persona (post-failure analysis, adjust plan, avoid repeating failures) and **mentor** (stall/loop detection) (`§4.6`). Reflection output is read-only advice, never a safety control (`§8.11`). |
| **Plan-and-execute / Plan-and-Solve** (Wang et al., 2023) | Commit to a full plan up front, then execute deterministically, re-planning only on failure. | Mirrors the run state machine: `planning → awaiting_gate1 → approved → executing` (`§3.3`). The approved plan is frozen into the **approved run envelope** before any execution. |
| **Tree-of-Thought / Pentest Task Tree (PTT)** (Yao et al., 2023; PentestGPT) | Represent the search space as a tree of candidate states/subtasks that can be expanded breadth- or depth-first. | The **test-plan → test-cases → subtasks** hierarchy (`test_plans`/`test_cases`/`subtasks` tables, §7). The orchestrator explores the open-subtask frontier; PTT is the citation. |
| **Blackboard / shared task list** (classic AI; Hearsay-II) | Independent specialists read and write a shared evolving workspace; a controller decides what to work on next. | The **engagement journal / shared task listing** the Orchestrator reads via `get_engagement_state` / `list_open_subtasks` (`§4.2`); backed by Postgres `subtasks` + Neo4j surface model + Redis Streams live events. See §8. |
| **Mentor / critic / LLM-as-judge** (CRITIC, Gou et al. 2023; constitutional/critique chains) | A second model critiques or verifies the primary agent's output rather than trusting it blindly. | **mentor** + **reflector** personas intervene on stalls; the **validator-assistant** normalises candidates into a replay spec but **does not judge** — judgement is the deterministic Validator. Enforces §8.11 (no model-dependent safety). |

---

## 3. Claude Agent SDK facts for the runtime

Package: **`@anthropic-ai/claude-agent-sdk`** (TypeScript) — Claude Code packaged as a library; pin an exact version (`CONTEXT_PACK §4`). Verified against **code.claude.com/docs/en/agent-sdk** (typescript, subagents, approvals, hooks, env-vars) on 2026-10-19.

### 3.1 `query()` options (names confirmed in the TS reference)
- `model` (alias or full ID); `fallbackModel` (used on primary failure; accepts comma-separated list — only set if tenant provider policy allows, `§4.3`).
- `maxTurns` (agentic turn ceiling = persona step ceiling); `maxBudgetUsd` (client-side estimate cap; **can overshoot** — gateway is the primary budget guard, `§4.3`); `thinking` (replaces deprecated `maxThinkingTokens`); `effort` per persona (on `AgentDefinition`: `'low'|'medium'|'high'|'xhigh'|'max'|number`).
- `permissionMode`: one of `default | acceptEdits | bypassPermissions | plan | dontAsk | auto`. **Blackwing uses `'default'`, never `bypassPermissions`** (`§4.3`, §8.11).
- `allowedTools` (auto-approves listed tools; does **not** restrict Claude to only them) and `disallowedTools` (a bare name removes the tool from context; a scoped rule like `"Bash(rm *)"` denies matching calls in *every* mode including bypass). Blackwing always disallows `WebFetch`/`WebSearch` and networked built-ins (`§4.3`).
- `canUseTool` (callback; fires only when the permission flow falls through to a prompt — **not** for auto-approved tools, and for `AskUserQuestion`). Blackwing has no interactive prompts in sandboxes, so enforcement lives in the **PreToolUse hook**, which runs *before* the rest of the flow and can allow/deny/modify every call.
- `hooks` (per-event callbacks), `agents` (programmatic subagents, see §3.2), `mcpServers` (see §4 of this file).
- `settingSources: []` to skip filesystem settings (Blackwing sets `[]`, `§4.3`).
- `env` — **the TS SDK *replaces* the subprocess environment** (spread `process.env` to keep `PATH`). Blackwing passes a minimal env with `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, telemetry vars (`§4.3`).
- `cwd`, `includePartialMessages: true` (live run view), `resume` (session ID to resume — used for Gate 2 / mentor), `outputFormat: { type: 'json_schema', schema }` (planner/sub-planner/validator-assistant/reporter), `abortController` (wired to kill switch; `query.interrupt()` on operator pause).
- Custom tools: **`createSdkMcpServer({ name, version?, instructions?, tools, alwaysLoad?, timeout? })`** runs in-process; **`tool(name, description, inputSchema /*Zod*/, handler, extras?)`** where `extras.annotations` carries MCP hints (`readOnlyHint`, `openWorldHint`) and `alwaysLoad` keeps the schema in the initial prompt.

### 3.2 Subagents (native, *inside* a specialist session only — `§4.2`)
- Defined programmatically via the **`agents`** option (`AgentDefinition`: `description`, `prompt`, `tools`, `disallowedTools`, `model` (`inherit`/alias/full), `maxTurns`, `effort`, `permissionMode`, `background`, `skills`, …). Claude invokes them through the **`Agent`** tool (appears as `"Task"` in the `system:init` tools list; match both names).
- Benefits: context isolation (only the final message returns to the parent), parallelization, specialized prompts, tool restrictions.
- **Caps (set via `env`):** `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default **3**; Blackwing sets **1** so helpers can't nest), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default **20**; Blackwing sets **4**), plus `maxBudgetUsd` (spend cap; `error_max_budget_usd` subtype at the limit). Helpers **share the specialist's sandbox and egress identity** (`§4.2`) — so cross-sandbox scaling uses `dispatch_subtask` + Temporal child workflow, *not* the Agent tool.
- Blackwing specialist helpers: e.g. `payload-crafter`, `response-differ` (`§4.2`).

### 3.3 Hooks (deterministic enforcement — §8.11)
- **`PreToolUse`**: policy check through the PDP. Returns a permission decision in `hookSpecificOutput` with `permissionDecision` ∈ **allow | deny | ask | defer** plus `permissionDecisionReason`. Hooks run **before** permission modes, so a `deny` holds even under `bypassPermissions`.
  - **Deferred-tool mechanism** (for human Gate 2, verified on the approvals/hooks pages): if a decision may take longer than the process can stay up, the hook returns **`defer`** → the session ends with `stop_reason: 'tool_deferred'` and the pending call surfaces as **`deferred_tool_use`**. The Run Controller waits for the human (timeout ⇒ deny, `§4.2`/F13), then **`resume`s the session** and the hook returns `allow`/`deny`. Note (`§4.2`): `defer` is **ignored for a parallel tool batch** → there, deny with a reason and pause the branch.
- **`PostToolUse`**: audit, evidence capture, redaction of known secret values (`updatedToolOutput`), output truncation with pointer-to-evidence (`§4.3`, §8.7).
- Other lifecycle hooks Blackwing uses: `PreCompact` (archive transcript), `SessionStart`/`SessionEnd`, `SubagentStart`/`SubagentStop` (telemetry), `Stop` (completion check — subtask result must be submitted). `PermissionRequest` hook can fire external notifications when approval is pending.

### 3.4 `SDKResultMessage` → subtask status (`§4.4`)
Read these fields: `subtype` ∈ **`success` | `error_max_turns` | `error_max_budget_usd` | `error_during_execution` | `error_max_structured_output_retries`**; `stop_reason` (incl. **`tool_deferred`**); `total_cost_usd`; **`modelUsage`** (per-model — prefer it for accounting); `usage`; `num_turns`; `duration_ms`; **`permission_denials`**; `structured_output`; `session_id`. **Model refusals** → mark subtask `model_declined`, record in coverage manifest, never rephrase/evade; the eval harness tracks refusal rate (`§4.4`).

### 3.5 Session persistence, gateway & providers
- **`sessionStore`**: Postgres/S3-backed adapter so sessions survive pod loss and can be resumed for Gate 2 / Mentor (`§4.3`).
- **Model access via gateway**: Claude Code reaches Claude through **`ANTHROPIC_BASE_URL`** pointed at the Blackwing **model-gateway**, authenticated with a short-lived **per-session virtual key** (`ANTHROPIC_API_KEY=bwk_…`). Real provider credentials never enter the sandbox (`§4.1`).
- **Providers**: Anthropic API (default), **Amazon Bedrock** (`@anthropic-ai/bedrock-sdk`; model IDs prefixed `anthropic.`), **Google Vertex AI** (`@anthropic-ai/vertex-sdk`), **Microsoft Foundry** (`@anthropic-ai/foundry-sdk`).
- **Policy (hard rule, `§4.5`):** production/customer runs authenticate with an **Anthropic API key or a cloud provider (Bedrock/Vertex/Foundry)**. **A claude.ai subscription login must NOT power third-party product runs** (Agent SDK terms). Developers may use their own Claude Code subscription only for *building* Blackwing. Azure OpenAI / GPT is not supported (`§1.1`).
- **Scaling note:** for jobs coordinating dozens–hundreds of agents the SDK offers the **`Workflow`** tool (orchestration moved into a script outside conversation context). Blackwing's cross-sandbox scaling is Temporal child workflows (`§4.2`); treat `Workflow` as an alternative to evaluate, not a current dependency.

---

## 4. MCP (Model Context Protocol) ecosystem for security & automation

- **Pattern Blackwing uses (primary):** wrap every internal capability as an **in-process SDK MCP server** via `createSdkMcpServer` + `tool()` (`§3.1` above, `CONTEXT_PACK §4.1`). This keeps tool backends inside `apps/agent-runtime`, reachable only through the Run Broker API, with no extra network surface. Prefer this over spawning external MCP server processes.
- **`@playwright/mcp`** (Microsoft, official) — browser automation MCP server. Drives Chromium/Firefox/WebKit/Edge via the **accessibility tree** (structured snapshot + element `ref` IDs, not screenshots/vision → far cheaper tokens). Supports navigation, forms, uploads, dialogs, console/network inspection, screenshots, JS eval; persistent vs isolated sessions, storage-state reuse, device emulation. Blackwing exposes it to specialists **proxy-configured** through the egress gateway (`CONTEXT_PACK §5` "Browser"). Issues: route it through `HTTP_PROXY/HTTPS_PROXY` + per-run CA; never give it direct internet.
- **Villager** (§1) is a notable *security-relevant* MCP client (MCP driving Kali toolsets) — cite as the pattern precedent and the abuse cautionary tale; do not use.
- **Tool-naming conventions (follow in issues):**
  - MCP tools surface to Claude as `mcp__<server>__<tool>` (e.g. `mcp__blackwing__dispatch_subtask`). Use snake_case verb-first tool names.
  - Blackwing engagement/MCP tool names are already fixed in `§4.2`: `get_engagement_state`, `list_open_subtasks`, `dispatch_subtask`, `get_subtask_result`, `request_mentor_review`, `mark_test_case_status`, `request_scope_exception`; plus specialist tools `http_request`, `tcp_probe`, `submit_candidate`, journal/oob/session-manager tools, `intel_*` (gateway-allowlisted OSINT).
  - Mark read-only tools with the `readOnlyHint` annotation so the planner/PDP can reason about intrusiveness.

---

## 5. Open-source security toolchain by phase (with licences)

All run **inside the `bw-sandbox` image**, traffic forced through the egress gateway (`CONTEXT_PACK §4.1`, §5). **Pin every tool version + nuclei template commit** (§8.9). Verify a tool's current licence in its repo before an issue assumes bundling is allowed.

| Phase | Tool (project) | Licence | Purpose (one line) | Notes for issues |
|---|---|---|---|---|
| Recon/discovery | **subfinder** (projectdiscovery) | MIT | Passive subdomain enumeration | passive-recon; gateway intel allowlist for third-party sources. |
| Recon/discovery | **dnsx** (projectdiscovery) | MIT | Fast DNS toolkit/resolver | respect anti-rebinding (resolve-once, pin IP) at the gateway (§8.2). |
| Recon/discovery | **httpx** (projectdiscovery) | MIT | HTTP probing / tech + status/title detection | active-recon surface confirmation. |
| Recon/discovery | **naabu** (projectdiscovery) | MIT | Fast port scanner (SYN/CONNECT) | active-recon / infra; `active_safe` class, in-scope ports only. |
| Recon/discovery | **katana** (projectdiscovery) | MIT | Crawler / endpoint & parameter discovery | active-recon; proxy-routed. |
| Recon/discovery | **ffuf** (ffuf) | MIT | Content/parameter fuzzing (wordlist) | active-recon/web; budget-bounded via proxy creds. |
| Fingerprint | **fingerprintx** (praetorian) | MIT | Service fingerprinting over raw ports | infrastructure-specialist. |
| Fingerprint/vuln | **nuclei** (projectdiscovery) | MIT (engine) | Template-driven detection engine | **nuclei-templates** also MIT but **pin the template commit** (§8.9); use safe/non-intrusive templates; proof at runtime. |
| TLS/config | **testssl.sh** | **GPLv2** | TLS/SSL configuration & cipher assessment | infra-specialist; GPLv2 → invoke as a separate binary, do not statically link into proprietary code. |
| OOB / OAST | **interactsh** (projectdiscovery; server + client) | MIT | Out-of-band interaction (DNS/HTTP/SMTP) listener for blind-vuln confirmation | self-hosted `interactsh-server` + `packages/oob`; the OOB oracle for F15 (see §7). |
| Secrets/code | **gitleaks** | MIT | Secret detection in source/git history | code-specialist (white box); findings proven at runtime, not shipped as SAST (`§1.1`). |
| Secrets/code (SAST-style) | **opengrep** | **LGPL-2.1 (engine)** | Pattern-based static analysis; community fork of Semgrep CE | **Use Opengrep, not Semgrep**, to stay clear of Semgrep's registry-rule licence (below). Author your own rules or use clearly open rules. |
| Secrets/code (SCA/containers) | **trivy** (Aqua) | Apache-2.0 | Vulnerability/misconfig/secret scanner for deps, images, IaC | used in CI (SBOM/scan) and for dependency-risk leads proven at runtime. |
| HTTP/crawl/browser | **Playwright** + Chromium | Apache-2.0 | Headless browser automation | via `@playwright/mcp` (§4), proxy-configured. |
| Misc | **jq** (MIT), **proxychains-ng** (GPLv2), **sqlmap** (GPLv2, **safe flags only**), **Python 3 stdlib** | mixed | JSON processing; force proxy for non-proxy-aware tools; injection detection with benign probes | sqlmap/proxychains GPLv2 → separate processes only. |

**Restrictive-licence watch-list — do NOT bundle without legal sign-off (`CONTEXT_PACK §5` "License review gate"):**
- **nmap** — **NPSL (Nmap Public Source License)**, a modified GPLv2 that forbids embedding in proprietary products (stand-alone redistribution, appliance, **docker container, VM** all counted; reading `nmap-service-probes`/`nmap-os-db` makes you a derivative). **Not bundled.** Use naabu + fingerprintx instead.
- **Semgrep registry rules** — the **Semgrep Rules License** limits use to internal, non-competing, **non-SaaS** contexts (changed Dec 2024). Semgrep CE *engine* is LGPL-2.1, but the **rules are the problem for a SaaS**. **Not bundled** — use Opengrep + own rules.
- Any **GPL/LGPL** CLI (testssl.sh, sqlmap, proxychains-ng, nuclei is MIT so fine) → invoke as separate processes; never statically link into Blackwing's proprietary code.

---

## 6. Standards & data sources to cite in issues (by identifier)

Issues should map every finding/test to a standard ID. Use these exact identifiers.

**OWASP Web Security Testing Guide (WSTG v4.2)** — top-level categories (cite the subtest, e.g. `WSTG-INPV-05`):
- `WSTG-INFO` Information Gathering · `WSTG-CONF` Configuration & Deployment Management · `WSTG-IDNT` Identity Management · `WSTG-ATHN` Authentication · `WSTG-ATHZ` Authorization · `WSTG-SESS` Session Management · `WSTG-INPV` Input Validation · `WSTG-ERRH` Error Handling · `WSTG-CRYP` Cryptography · `WSTG-BUSL` Business Logic · `WSTG-CLNT` Client-side · `WSTG-APIT` API Testing.

**OWASP Top 10 2021** — `A01` Broken Access Control · `A02` Cryptographic Failures · `A03` Injection · `A04` Insecure Design · `A05` Security Misconfiguration · `A06` Vulnerable & Outdated Components · `A07` Identification & Authentication Failures · `A08` Software & Data Integrity Failures · `A09` Security Logging & Monitoring Failures · `A10` Server-Side Request Forgery (SSRF).

**OWASP API Security Top 10 2023** — `API1` Broken Object Level Authorization (BOLA) · `API2` Broken Authentication · `API3` Broken Object Property Level Authorization (BOPLA) · `API4` Unrestricted Resource Consumption · `API5` Broken Function Level Authorization (BFLA) · `API6` Unrestricted Access to Sensitive Business Flows · `API7` Server-Side Request Forgery · `API8` Security Misconfiguration · `API9` Improper Inventory Management · `API10` Unsafe Consumption of APIs.

**OWASP ASVS** — current **v5.0.0** (released 30 May 2025; ~350 reqs across 17 chapters; CC BY-SA 4.0). Cite requirements as `v5.0.0-<chapter>.<section>.<req>` (e.g. `v5.0.0-1.2.5`). v4.0.3 mapping exists for legacy references; auth/session/input-validation issues should cite the ASVS requirement they verify.

**MITRE CWE** — cite class as `CWE-<id>` (e.g. `CWE-89` SQL Injection, `CWE-79` XSS, `CWE-918` SSRF, `CWE-639`/`CWE-862` authorization). **CWE Top 25 (2025 edition)** is the latest (XSS `CWE-79` #1, SQLi `CWE-89` #2, CSRF `CWE-352` #3; built from ~39,080 CVEs Jun-2024→Jun-2025; 113 of them in CISA KEV). Store on findings as `cwe_id` (§7 domain model).

**FIRST CVSS v4.0** — current scoring standard (FIRST, released Nov 2023). Metric groups: Base / Threat / Environmental / Supplemental; nomenclature `CVSS-B`, `CVSS-BT`, `CVSS-BTE`. Blackwing stores a **CVSS v4.0 vector + score** on `findings.severity`, with a v3.1 vector optional (§7). Do not invent scores — derive from the vector.

**Vulnerability intelligence data sources** (threat-intel persona, `intel_*` tools; §4.6):
- **NVD CVE API 2.0** (`services.nvd.nist.gov/rest/json/cves/2.0`) — authoritative CVE records/CPE/CVSS; rate-limited (API key recommended).
- **CISA KEV** (Known Exploited Vulnerabilities catalogue) — vulns with confirmed in-the-wild exploitation; use to raise priority.
- **FIRST EPSS** — probability (0–1) a CVE is exploited in the next 30 days; use alongside CVSS/KEV for prioritisation, never as the sole severity input.
- **OSV.dev** (Google) + **GitHub Advisory Database (GHSA)** — package-ecosystem advisories with affected-version ranges; `GHSA-xxxx-xxxx-xxxx` / `OSV` IDs for dependency-risk findings (proven at runtime, not shipped as SCA, `§1.1`).

**SARIF 2.1.0** — OASIS Standard (approved 27 Mar 2020; **Errata 01** 28 Aug 2023 is the current text). Common static-analysis results interchange format; Blackwing's F25 export is SARIF **2.1.0**, validated with **Ajv against the official schema** (`CONTEXT_PACK §5`). Map finding → SARIF `result` with `ruleId`, `level`, `locations`, and taxonomy references (CWE/OWASP) in `taxa`.

---

## 7. Validation / false-positive-reduction prior art

Blackwing's confirm-before-report discipline (F14–F18, §3.2 step 9) draws on established ideas. Every specialist-finding issue must require these.

| Technique | Where it comes from | How issues must require it |
|---|---|---|
| **Negative controls** | Experimental design / controlled-experiment methodology; mirrored in scanner "sanity"/baseline checks. | Each test case declares a **`negative_control`** (§7 `test_cases.negative_control`): a parallel benign/known-safe case that must **not** trigger the oracle. A candidate is confirmable only if the positive fires **and** the negative does not (F16). |
| **Out-of-band (OAST) confirmation** | PortSwigger **Burp Collaborator** / OAST concept; implemented open-source via **interactsh**. | Blind/second-order classes (e.g. SSRF, blind injection, XXE OOB) bind to the **OOB listener oracle** (F15, `oob_correlations`/`oob_interactions`, §7): confirmation = a correlated inbound interaction on the per-test token, not a model's say-so. |
| **Deterministic replay** | Record-and-replay testing; reproducibility practice; motivated by LLM non-determinism (Vulnhuntr's own caveat, §1). | The **Validator** replays each candidate in a **fresh sandbox** against its **pre-declared oracle** via `packages/replay` (F14). The oracle (`test_cases.oracle`: type + params) is declared **before** the test runs; post-hoc oracles are invalid. |
| **Confirmed vs Suspected separation** | Scanner confidence tiers (e.g. Burp certain/firm/tentative; Nessus/Nuclei confidence); Strix "prove with PoC"; Vulnhuntr confidence score. | Validator pass → **Confirmed** (evidence + standalone repro artifact, F18); fail → **Suspected** queue (analyst-only, F17). A finding is `fixed` only if the coverage manifest shows the relevant test executed (§3.4). Promotion of `suspected` requires a successful **re-validation**, never manual flip. |

Cross-cut: all of the above are **deterministic code**, not model judgement (§8.11). The `validator-assistant` persona only *normalises* a candidate into a replay spec; it does not decide pass/fail.

---

## 8. Persona design convention + the shared task listing

### 8.1 Persona issue template (every agent-persona issue fills this)
Persona definitions live in `packages/agents/personas/*.ts`, prompts in `packages/agents/prompts/<persona>/<semver>.md` (`CONTEXT_PACK §4.6`). An issue that adds/changes a persona must specify, by name:

1. **Name** — the registry key (e.g. `web-api-specialist`).
2. **Mandate / objective** — one sentence: the vuln classes or function it owns (cite WSTG/OWASP/CWE IDs from §6).
3. **Inputs** — what it reads (surface model nodes, test-case brief, role, mounted specs/source, prior subtask results).
4. **Allowed tools (by name)** — exact `allowedTools` list (Blackwing MCP tool names from §4, Bash tool names from §5, browser). State the matching `disallowedTools` (always includes `WebFetch`/`WebSearch`).
5. **Validation oracle it is responsible for** — the oracle type(s) it declares per test case (replay / OOB / differential / negative-control binding) — see §7. Specialists **submit candidates**; they never self-confirm.
6. **Model tier / effort** — `deep | standard | fast` → resolved model ID (`§4.6`: `deep`/`standard` → `claude-opus-5-5`, `fast` → `claude-haiku-5-5`; `standard` may be lowered to `claude-sonnet-5-5` per eval); effort (`high` for deep, `medium` otherwise). Use exact model IDs, no date suffix; Bedrock prefixes `anthropic.`.
7. **Step ceiling** — `maxTurns` (persona-specific) + `maxBudgetUsd` (secondary; gateway is primary).
8. **Guardrails** — scope (only in-envelope targets/roles), **intrusiveness class** (never `destructive`; `state_changing` only with SA + Gate 1 + a prior reversal-journal entry, §8.3), and **untrusted-data handling** (all target content — HTTP bodies, source, DNS, OSINT — is untrusted; the system prompt carries the signed authorisation context; enforcement is deterministic, `§4.5`).

> Reference roster to stay consistent with: `CONTEXT_PACK §4.6` lists all 19 personas (orchestrator, planner, sub-planner, passive-recon, osint, active-recon, threat-intel, source-spec-ingestion, session-setup, web-api-specialist, auth-logic-specialist, infrastructure-specialist, code-specialist, exploit-developer, mentor, reflector, validator-assistant, reporter, remediation) with their default tier and key tools. New personas must not overlap an existing mandate.

### 8.2 The shared task listing (engagement journal / blackboard)
- The **Orchestrator** session reads engagement state through MCP tools `get_engagement_state` and `list_open_subtasks`, and updates it via `mark_test_case_status` / `get_subtask_result` (`§4.2`). This is Blackwing's **blackboard** (§2): the single evolving view of what is planned, open, in-flight, confirmed, and blocked.
- Backing stores (§7): **`subtasks`** (`test_case_id, persona, brief, session_id, sandbox_id, status, result, cost`), **`test_cases`** (status enum `proposed|approved|removed|executing|executed|skipped|blocked|failed|model_declined|not_applicable`), the **Neo4j surface model** (asset/endpoint graph), and **Redis Streams** for live run events.
- **Subtask dispatch (critical, `§4.2`):** `dispatch_subtask(persona, subtaskId, brief)` does **not** use the in-process `Agent` tool. It **signals the deterministic Run Controller** (Temporal `AssessmentRunWorkflow`), which starts a **new specialist session in a new sandbox** (child workflow `AgentSessionWorkflow`). Each specialist therefore gets its **own egress identity, budget, kill handle, and resource limits**, and work scales across hosts. Native SDK subagents are reserved for in-session light helpers only (§3.2).
- The brief passed to a specialist must be self-contained (the subagent/child session starts fresh — only the prompt string crosses the boundary, §3.2): include target endpoints, role, intrusiveness class, declared oracle, negative control, budget, and the relevant WSTG/CWE IDs.

---

## How author-agents should use this file

- **Cite by identifier, always.** In a specialist issue, name the vulnerability **class + standard ID** (e.g. "detect SSRF-class issues — `CWE-918`, `WSTG-INPV-19`, OWASP `A10`/`API7` — bind each candidate to a declared oracle (§7) and a negative control; capture request/response evidence via the gateway"). Never write payload strings, attack walkthroughs, or bypass recipes (AUTHOR_BRIEF §"Content safety & altitude").
- **Reuse the vocabulary.** Use the exact pattern names (§2: orchestrator–worker, ReAct, Reflexion, plan-and-execute, PTT, blackboard, mentor/critic), the exact SDK field/option names (§3), the exact tool names and licences (§5), and the standard IDs (§6). This keeps issues consistent and self-contained.
- **Ground design claims in prior art.** When an issue justifies a design (deterministic validator, confirm-vs-suspect, OOB confirmation, source→sink tracing, task-tree planning), cite the project/paper here (§1, §7) rather than re-arguing it.
- **Fill the persona template (§8.1) in full** for any persona issue, and treat the **shared task listing + `dispatch_subtask`→Run Controller** flow (§8.2) as fixed — do not let a persona spawn cross-sandbox work via the native `Agent` tool.
- **Respect the licence watch-list (§5):** never propose bundling nmap (NPSL) or Semgrep registry rules; use the named open alternatives.
- **Where this file and `CONTEXT_PACK.md` differ, the pack wins** — this file is prior art and vocabulary, not a source of architectural decisions.
