# Blackwing SaaS

**Blackwing** is an autonomous security-assessment platform that runs **under human authorisation**. It performs black-, grey- and white-box assessments with a team of AI agents (powered by **Claude Code / the Claude Agent SDK**), reaches targets only through a scoped egress gateway, proves every finding with a deterministic validator, and releases findings only after human triage. Three human gates (scope approval, runtime exception, triage & release) and a customer-held kill switch keep it safe.

This repository is the **SaaS edition** (multi-tenant, Blackwing-operated on AWS). An on-prem edition is tracked for later.

## Where to start
- **Architecture & engineering source of truth:** [`docs/architecture/CONTEXT_PACK.md`](docs/architecture/CONTEXT_PACK.md)
- **Diagrams:** [`docs/architecture/blackwing-architecture.html`](docs/architecture/blackwing-architecture.html) (System Context, Components, Agent Org & Data Flow, Assessment Modes, Deployment)
- **Feature list:** [`docs/architecture/FEATURE_LIST.md`](docs/architecture/FEATURE_LIST.md)
- **Epic catalogue:** [`docs/architecture/EPICS.md`](docs/architecture/EPICS.md)
- **Prior art & tooling references:** [`docs/architecture/REFERENCES.md`](docs/architecture/REFERENCES.md)
- **Work tracking:** GitHub Issues (epics + task sub-issues) and the *Blackwing SaaS v1* project board.

## Working in this repo
Pick up any `type:task` issue — each is self-contained. Follow `CONTEXT_PACK.md` (§5 stack, §6 paths, §7 domain model, §8 security invariants, §10 Definition of Done). See [`CLAUDE.md`](CLAUDE.md).

## Status
Pre-implementation: architecture and the full v1 backlog are defined; implementation proceeds issue by issue.
