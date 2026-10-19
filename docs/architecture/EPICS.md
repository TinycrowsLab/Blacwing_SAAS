# Blackwing SaaS v1 — Epic Catalogue

69 epics, 626 seed issues across 11 milestones. Each epic is a GitHub issue (`type:epic`) with child task issues (sub-issues). See `CONTEXT_PACK.md` for the full design.


## M0 - Foundations & Dev Environment

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `FOUND` | Monorepo, shared libraries & engineering conventions | Foundations | P0 | 15 |  |
| `DEVENV` | Developer environment on AWS EC2 and local dependency stack | Foundations | P0 | 11 | F41 |
| `CI` | CI/CD pipelines, supply-chain security & release engineering | Foundations | P0 | 13 | F37 |
| `INFRA` | AWS infrastructure (OpenTofu), k3s cluster, networking, DNS & TLS | Infrastructure | P1 | 16 | F41 F11 |

## M1 - Platform Core (Tenancy, Identity, Data, Audit, Secrets)

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `TENANT` | Multi-tenant SaaS core: organisations, onboarding & isolation | Tenancy | P0 | 11 | F29 F41 |
| `IAM` | Identity, SSO (Keycloak) & session management | Access Layer | P0 | 11 | F30 F29 |
| `RBAC` | Roles, permissions, service accounts & scoped CI tokens | Access Layer | P0 | 10 | F29 F31 |
| `API` | API platform: REST & GraphQL conventions | Access Layer | P0 | 14 | F29 |
| `DB` | PostgreSQL schema, migrations, RLS & data-access layer | Tenancy | P0 | 10 | F34 F39 |
| `GRAPH` | Asset & surface graph (Neo4j) | Tenancy | P1 | 8 | F7 F12 |
| `WORKFLOW` | Durable workflow & job infrastructure (Temporal, queues, events) | Platform Services | P0 | 9 | F12 F13 |
| `AUDIT` | Audit ledger & SIEM export | Platform Services | P0 | 11 | F34 |
| `SECRETS` | Secrets service, envelope encryption & customer key stores | Platform Services | P0 | 12 | F35 |
| `NOTIFY` | Notification service: email, chat, webhooks & paging | Platform Services | P1 | 9 | F13 F33 |

## M2 - Assets, Scoping, Authorisation & Policy

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `ASSET` | Asset inventory, ownership verification & environment attestation | Authorisation & Policy | P0 | 12 | F6 F1 F7 |
| `SCOPE` | Scoping form, mode & input manifest, intrusiveness & request budgets | Authorisation & Policy | P0 | 11 | F1 F4 F5 F7 |
| `AUTHZ` | Standing authorisation register & separation of duties | Authorisation & Policy | P0 | 11 | F3 F31 F6 |
| `POLICY` | Policy decision point & customer-owned policy layer (Cedar) | Authorisation & Policy | P0 | 10 | F32 F4 F11 F13 |
| `PLAN` | Test-plan model, editable plan & Gate 1 approval | Authorisation & Policy | P0 | 10 | F2 F4 F5 F14 F16 F31 |

## M3 - Execution Sandbox & Egress Control

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `SANDBOX` | Sandbox controller & disposable run sandboxes | Execution Sandbox | P0 | 11 | F41 F11 F12 |
| `IMAGE` | Sandbox image & security toolchain | Execution Sandbox | P1 | 11 | F37 F12 |
| `EGRESS` | Scoped egress gateway (Go): allowlist, budgets, capture, fail-closed | Execution Sandbox | P0 | 16 | F11 F5 F4 F33 F20 |
| `SESSION` | Session & credential manager: multi-role logins, keep-alive, lockout guard | Execution Sandbox | P0 | 12 | F8 F10 F35 |
| `BROWSER` | Browser automation runtime (Playwright) | Execution Sandbox | P1 | 7 | F12 F8 |
| `OOB` | Out-of-band listener (interactsh) & correlation | Validation & Findings | P1 | 7 | F15 F14 |
| `KILL` | Kill switch, test-window notices & Customer SOC access | Authorisation & Policy | P0 | 11 | F33 |

## M4 - Agent Runtime on Claude Code

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `GATEWAY` | Model gateway: Claude routing, virtual keys, redaction, cost caps & pinning | Model & Memory | P0 | 15 | F36 F38 F37 |
| `RUNTIME` | Agent runtime host on the Claude Agent SDK | Agent Runtime | P0 | 14 | F12 F13 F37 F38 |
| `ORCH` | Run orchestration: Temporal run workflow & orchestrator agent | Agent Runtime | P0 | 14 | F12 F7 F13 F17 F21 |
| `REGISTRY` | Agent registry, personas, prompt versioning & model tiers | Agent Runtime | P0 | 15 | F12 F37 |
| `MCP` | Blackwing MCP tool layer for agents | Agent Runtime | P0 | 14 | F11 F14 F15 F17 F20 |
| `MEMORY` | Context manager, engagement journal & memory/knowledge | Model & Memory | P1 | 9 | F12 |
| `GATE2` | Runtime exception gate (Gate 2) & on-call paging | Authorisation & Policy | P0 | 9 | F13 F31 |

## M5 - Recon, Planning & Assessment Specialists

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `MENTOR` | Mentor & Reflector (stall detection & recovery) | Agent Runtime | P2 | 6 | F12 |
| `RECON` | Recon agents: passive recon, OSINT, active recon & session setup | Recon & Specialists | P0 | 11 | F7 F12 F8 F10 |
| `INTEL` | Threat intelligence & enrichment | Recon & Specialists | P1 | 9 | F12 F26 |
| `INGEST` | Source & spec ingestion (grey/white box) | Recon & Specialists | P1 | 10 | F7 F8 F12 |
| `PLANNER` | Planner & sub-planner agents | Agent Runtime | P0 | 8 | F2 F4 F5 F14 F16 F7 |
| `WEBAPI` | Web & API assessment specialist | Recon & Specialists | P1 | 11 | F8 F12 F14 F16 F26 |
| `AUTHLOGIC` | Authorisation, access-control & business-logic specialist | Recon & Specialists | P1 | 9 | F9 F8 F12 F14 F16 |
| `INFRASPEC` | Infrastructure & configuration specialist | Recon & Specialists | P2 | 7 | F12 F14 F26 |
| `CODESPEC` | Code (white-box) specialist | Recon & Specialists | P2 | 7 | F12 F14 F26 |
| `EXPLOIT` | Exploit developer & tooling support (sandbox-only, non-destructive) | Recon & Specialists | P2 | 5 | F12 |

## M6 - Validation, Evidence & Findings

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `VALIDATE` | Validator: deterministic replay, negative controls & confirmed/suspected | Validation & Findings | P0 | 9 | F14 F16 F17 F18 |
| `EVIDENCE` | Evidence store (write-once, hashed) & chain of custody | Validation & Findings | P0 | 7 | F18 F34 F39 |
| `FINDING` | Findings model, dedup & fingerprinting, severity & mapping | Validation & Findings | P0 | 7 | F17 F22 F26 F23 |
| `COVERAGE` | Coverage manifest & export gate | Validation & Findings | P0 | 6 | F19 |
| `REVERSAL` | Reversal journal (undo of state changes) | Validation & Findings | P1 | 6 | F20 F4 |
| `REPRO` | Standalone repro artifacts | Validation & Findings | P1 | 5 | F18 |

## M7 - Triage, Reporting & Integrations

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `TRIAGE` | Triage & release (Gate 3) & auto-release lanes | Triage & Delivery | P0 | 6 | F21 F17 F31 F44 |
| `REPORT` | Report generation & export (PDF/JSON/SARIF) | Triage & Delivery | P0 | 7 | F25 F26 F19 F18 |
| `CONNECT` | Issue-tracker & SCM integrations (Jira, GitHub/GitLab) | Triage & Delivery | P1 | 8 | F27 F42 |
| `REMEDIATE` | Remediation guidance & one-click retest | Triage & Delivery | P1 | 5 | F24 F23 F27 |
| `BASELINE` | Baseline runs & diff (new/open/fixed/returned) | Triage & Delivery | P1 | 5 | F23 F22 |

## M8 - Console & Dashboards

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `CONSOLE` | Web console shell, navigation & design system | Console | P0 | 7 | F29 |
| `LIVERUN` | Live run view & run management | Console | P1 | 6 | F12 F13 F33 F17 |
| `DASH` | Vulnerability dashboard & reporting views | Console | P1 | 6 | F28 F26 F23 |
| `ADMIN` | Organisation administration & platform-operator console | Console | P1 | 9 | F29 F30 F31 F32 F34 F35 F36 F39 |
| `SOCUI` | Customer SOC portal | Console | P2 | 4 | F33 |

## M9 - Production Readiness & Launch

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `OBS` | Observability: telemetry, metrics, logs, traces & alerting | Production Readiness | P1 | 8 | F34 F38 |
| `COST` | Token & cost tracking, budgets & spend caps | Production Readiness | P1 | 5 | F38 |
| `SCHED` | Scheduler: recurring runs & blackout windows | Production Readiness | P2 | 5 | F43 |
| `RETAIN` | Retention, data lifecycle & deletion | Production Readiness | P1 | 5 | F39 F35 F34 |
| `EVAL` | Evaluation harness & regression gate | Production Readiness | P1 | 6 | F40 F37 |
| `SECREVIEW` | Security hardening, threat model & pre-launch review | Production Readiness | P0 | 7 | F31 F34 F35 F11 |
| `PERF` | Performance, load & resilience testing | Production Readiness | P2 | 6 | F11 F33 |
| `DOCS` | Documentation, runbooks & onboarding | Production Readiness | P2 | 6 |  |
| `LAUNCH` | End-to-end integration, UAT & launch readiness | Production Readiness | P0 | 5 | F7 F8 F9 |

## Later - Post-v1 Backlog

| Key | Epic | Area | Priority | Seeds | Features |
|---|---|---|---|---|---|
| `LATER` | Post-v1 backlog (tracked, not built in v1) | Backlog | P3 | 8 | F42 F43 F44 |
