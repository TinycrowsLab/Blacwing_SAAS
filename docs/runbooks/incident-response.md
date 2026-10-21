---
last_validated: never
---

# Incident response and on-call runbook (OBS, NOTIFY, KILL)

Owner: the on-call rota, with OBS for signals, NOTIFY for paging and KILL for stopping agents. Read with
[§8 (security invariants)](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch),
[§9 (API conventions, problem+json traceId)](../architecture/CONTEXT_PACK.md#9-api-conventions) and the
other runbooks in this folder: [kill-switch.md](kill-switch.md), [deploy-rollback.md](deploy-rollback.md) and
[disaster-recovery.md](disaster-recovery.md).

> **Status: not yet validated.** `last_validated: never` stays until a tabletop exercise and one live drill have run
> and their records are filed. Paging is **not wired**: the repo has no Alertmanager or PagerDuty routing and no
> alert rules, and NOTIFY (the notification service) is not implemented. Until it is, the escalation path below is
> manual.

## 1. Severities

Severities are set by impact on customers and on the §8 invariants, not by how noisy the alert is. When in doubt,
pick the higher severity and lower it later.

| Severity | Definition | Examples | Response target | Who is paged |
|---|---|---|---|---|
| **SEV1** | A §8 invariant is broken or may be broken, or a customer's data or target is at risk | Any target traffic without a valid envelope (§8.1); egress allows an out-of-scope target (§8.2); a cross-tenant read (§8.6); a kill that cannot be confirmed; a secret in plaintext in logs or sandboxes (§8.7); audit events missing (§8.8) | Acknowledge within 15 min, 24/7 | On-call engineer, incident commander, security owner, product owner |
| **SEV2** | Production is down or badly degraded for many tenants, or a kill is partially halted | Control plane unavailable; kill halt-time breached; `bw_kill_partial_halt_total` increments; provider outage for all tenants | Acknowledge within 30 min, 24/7 | On-call engineer and incident commander |
| **SEV3** | One tenant or one feature is degraded, with a workaround | A single tenant's runs stuck; one persona fails; slow dashboards | Acknowledge within 4 h, business hours | On-call engineer |
| **SEV4** | No customer impact, or a near miss | A failed backup job caught in a check; a runbook step that no longer matches the product | Next business day | Owning team |

Targets are **proposed** and must be ratified in the launch review. Any SEV1 or SEV2 on a §8 invariant also needs a
security review (SECREVIEW) before it is closed.

## 2. Roles

- **Incident commander (IC):** owns the timeline and decisions, and assigns the others. The IC does not also run
  the fix when SEV1.
- **Operator:** runs the technical steps and writes each action into the incident ticket with the time.
- **Comms lead:** sends internal and customer updates (section 6).
- **Security owner:** joins any SEV1 that touches §8, and decides on any kill or data action that affects evidence.

## 3. Escalation

1. The alert or report arrives. Open an incident ticket. Do not put secrets, tokens or customer data in the ticket.
2. Acknowledge within the response target in section 1.
3. Page according to the severity table. Paging goes through NOTIFY once it is live. Until then, use the on-call
   phone rota and the incident channel.
4. If the IC cannot be reached within 15 min for a SEV1, escalate to the engineering lead.
5. Every operator action taken during the incident is audited (§8.8). Operators record each one in the ticket, with
   the time and the audit event id where one exists.

**Signals to watch for paging.** The starter Grafana dashboard `Blackwing overview` (uid `bw-overview`) shows
`up` per scrape target. The kill signals in [kill-switch.md](kill-switch.md) (section 4) are the first place to look
for kill problems. Two alerts are required by the kill runbook and do not exist yet: `bw_kill_partial_halt_total`
increasing, and `bw_kill_audit_failures_total` increasing. Until they exist, check the dashboard and the logs
by hand during an incident.

## 4. Common incidents

### 4.1 Provider outage (model gateway)

- **Symptoms:** `bw_gw_provider_requests_total{provider,status}` shows errors (non-200) for one provider, and
  `bw_gw_provider_latency_ms{provider}` climbs. Runs stall in the model-dependent states of the run state machine.
- **Fallback policy:** **not implemented.** The code has no fallback model, and the fallback policy is not yet decided.
  Do not change the model in the console or config during the incident without the product owner's approval, because
  every run records the model IDs it used (§8.9).
- **Action:** confirm the outage with the provider's status page and the gateway metrics. Stop new run starts for
  the affected tenant if the outage will last. Target traffic still needs a valid envelope at the egress gateway
  (§8.1), and a model outage does not change that check. Kill any run that must stop.
- **Recovery:** when the provider recovers, confirm error ratio and latency are back to normal, then let the
  product owner decide which paused runs to resume. Killed runs stay killed (see [kill-switch.md](kill-switch.md)).

### 4.2 Egress gateway down (fail closed)

- **Behaviour (§8.2):** if the gateway cannot evaluate policy, reach its config or write capture, it blocks. So an
  outage means runs **cannot** reach targets. That is the intended result, not a second incident, but the runs stop
  making progress. The gateway also refuses to come up when its identity or config checks fail (see
  `apps/egress-gateway/README.md`, in particular the fail-closed defaults and the Valkey boot behaviour).
- **Signals:** `egress_up`, `egress_ready` and `egress_not_ready_reason` (readiness; `egress_identity_verifier_unavailable_total`
  shows verifier outages). A rise in `egress_identity_rejected_total` needs a security look.
- **Action:** find the reason from `egress_not_ready_reason` and the gateway logs. Fix the config or dependency, then
  restart the gateway. The gateway re-verifies the envelope and policy on load, so runs resume only with a valid,
  unexpired envelope.
- **Do not:** route traffic around the gateway, relax an allow-list, or disable identity checks to restore progress.
  Each of these is a SEV1.
- **Gap:** no egress deny-rate metric is exported yet, so "how many requests were denied during the outage" is answered
  from logs only.

### 4.3 Temporal issues

- **Symptoms:** kill events sit in `initiated`, or workflows stop advancing. `bw_kill_enqueue_failures_total` rises.
- **Behaviour:** a kill is recorded before it is enqueued. If enqueueing fails, the event stays `initiated` and the
  reconciler (KILL-004) retries. Every kill activity is idempotent, so a retry does not double-block or reset a
  timestamp.
- **Action:** check the Temporal service and its task queues. Until propagation runs, the kill is not enforced, so
  treat a stuck `initiated` kill as SEV2 and escalate at once. Do not assume it took effect: confirm the egress and
  sandbox outcomes with `GET /v1/kill/<killEventId>` before you close it. Use the infrastructure action agreed for
  the scope in the meantime, and record each step.
- **Gap:** Temporal workflow cancellation is part of KILL-006 and is **not implemented**. Do not claim a workflow was
  cancelled until it is.

### 4.4 Runaway agents or a suspected breach by an agent

- Trigger a `tenant` kill for the affected tenant (or `run` / `asset` if the scope is clear). A `global` kill is
  **not available** through the API yet. If many tenants are affected, escalate to SEV1 and stop the platform with
  an infrastructure action, recorded in the ticket.

### 4.5 Audit ledger gap

- `bw_kill_audit_failures_total` or a missing `kill.fired` / `kill.completed` event means an audit append failed.
  The kill still proceeds (§8.5), but this is SEV1 because §8.8 requires every kill to be audited. Find the cause,
  and do not hand-write audit events.

## 5. Operator hygiene

- **No secrets.** Never paste credentials, session cookies, `bw_pat_` / `bw_ci_` tokens, virtual keys or sandbox
  secrets into a ticket, a chat or a log. If one leaks, rotate it first and record the rotation (§8.7).
- **Redacted output only.** Use the redacted tool output and log views. Do not disable redaction to debug.
- **Customer data.** Keep it to the minimum needed. Refer to tenants by ID, not by name, in shared channels.

## 6. Communications

- **Internal:** the comms lead posts an update at the start, then at each severity change and at least every 60 min
  for SEV1 and SEV2. Each update has the time, the state, the impact and the next step.
- **Customers:** the account owner sends updates. Paging and notification templates belong to NOTIFY and are not
  built yet, so use the plain template below. Send it through the approved channel only.
  > We are investigating an issue affecting <scope>, first seen at <time UTC>. Runs in that scope are stopped while we
  > confirm impact. We will update by <time UTC>.
- **Status:** sent only with the product owner's approval.

## 7. Closing and review

1. Confirm the impact has ended and every affected run is in its correct terminal state.
2. Write the timeline from the ticket, and link the audit events and the kill event ids.
3. Hold a blameless review within 5 business days for SEV1 and SEV2. The output is a list of actions with owners.
4. For a SEV1 that touched a §8 invariant, the security owner signs the review.
5. Update the affected runbook if its steps were wrong, and set its `last_validated` only after the drill that
   checked the fix.

## Validation

1. **Tabletop (review):** walk through three scenarios, one SEV1 (egress gateway down), one SEV2 (kill partially
   halted) and one SEV1 (audit gap), with the on-call rota. Pass when each step names a real signal in this runbook
   and the escalation reaches the right roles.
2. **Live drill:** page a test alert in staging once NOTIFY exists, and confirm the rota acknowledges within the SEV2
   target.
3. File both records in tickets and link them here. Then set `last_validated` to the drill date.
