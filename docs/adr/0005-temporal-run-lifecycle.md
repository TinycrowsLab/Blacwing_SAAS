# ADR-0005: Drive the run lifecycle with Temporal workflows (hybrid orchestration)

Date: 2026-10-20

## Status

Accepted

## Context

An assessment run lasts hours, spans many agent sessions in many sandboxes, and waits on humans: Gate 1 plan
approval, Gate 2 runtime exceptions (where no reply by the timeout means denied) and Gate 3 release. It must
honour test windows, budgets, the kill switch and authorisation expiry, and it must survive process and host
loss. An LLM orchestrator alone cannot be trusted to enforce any of that, because safety cannot depend on model
compliance.

## Decision

- We use **self-hosted Temporal** with the TypeScript SDK for the run lifecycle: phases, gates (signals),
  timers (gate timeouts, test windows), schedules and retries.
- Orchestration is **hybrid: "LLMs decide; code enforces."** The deterministic Run Controller
  (`AssessmentRunWorkflow` in `apps/worker`) owns phases, gates, budgets, kill, timeouts and retries. The
  Orchestrator persona is a Claude Agent SDK session that decides what to do next through Blackwing MCP tools.
- When the Orchestrator dispatches a subtask, the Run Controller starts a **new specialist session in a new
  sandbox** as a child workflow (`AgentSessionWorkflow`), so each specialist has its own egress identity,
  budget, kill handle and resource limits. The in-process Agent tool is not used for this.
- The run state machine in `packages/domain/run` is authoritative; its state lives in Postgres with
  optimistic concurrency and is driven by the workflow.
- Valkey with BullMQ remains for short jobs only; it does not hold run state.

## Consequences

- Every gate wait, timeout and kill is durable and replayable, and a crashed worker resumes where it stopped.
- Workflow code must be deterministic, with all IO in activities; that convention is
  documented and lint-enforced separately (WORKFLOW-003, #24).
- Temporal becomes a core dependency of the dev stack and of production, with its own operations burden.

## References

- [Context Pack §4.2 Hybrid orchestration](../architecture/CONTEXT_PACK.md#42-hybrid-orchestration-why-and-how).
- [Context Pack §3.3 Run state machine](../architecture/CONTEXT_PACK.md#33-run-state-machine-authoritative-implement-in-packagesdomainrun).
- [Context Pack §5 Technology stack](../architecture/CONTEXT_PACK.md#5-technology-stack-fixed-for-v1-all-freeopen-source-except-the-aws-account-and-the-anthropicclaude-usage):
  rows "Durable workflows" and "Queue / cache / pub-sub".
- [Context Pack §8 Security invariants](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch):
  §8.5 (kill switch) and §8.11 (no model-dependent safety).
