---
last_validated: never
---

# Kill switch runbook (KILL, §8.5)

Owner: KILL. Read with [§3.3 (run states)](../architecture/CONTEXT_PACK.md#33-run-state-machine-authoritative-implement-in-packagesdomainrun),
[§8.2 (egress fails closed)](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch)
and [§8.5 (kill switch)](../architecture/CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch).

> **Status: not yet validated.** `last_validated: never` is the truth until the kill drill in
> [Validation](#validation) has run against staging and its record is filed. Steps below describe the code on
> `main`. Anything marked **not implemented** is absent from the product and must not be relied on.

## 1. What a kill does

One kill event stops every agent in its scope. The order is fixed by §8.5 and implemented in
`apps/worker/src/kill/propagate.ts` and `apps/worker/src/workflows/kill-propagation.ts`:

| Order | Stage | What happens | Budget (§8.5) | Code constant |
|---|---|---|---|---|
| 1 | `egress` | The egress gateway blocks the run's egress identities first. Retries use exponential backoff, up to 5 attempts. | p99 < 2 s | `EGRESS_DEADLINE_MS` (2 000 ms), `EGRESS_MAX_ATTEMPTS` |
| 2 | `sandbox` | Target sandboxes are force-terminated. Termination is acknowledged before the stage is recorded as done. | p99 < 10 s | `SANDBOX_DEADLINE_MS` (10 000 ms), overridable with `KILL_SANDBOX_DEADLINE_MS` (capped at 60 s) |
| 3 | virtual key revoke | **Not implemented.** KILL-006 adds it after the sandbox stage. | - | - |
| 4 | Temporal workflow cancel | **Not implemented.** KILL-006 adds it. | - | - |

If an egress block fails, the gateway already fails closed (§8.2), so the kill records `partially_halted` and the
later stages still run. A later stage that throws does not skip the stages after it. An empty target set completes
immediately with `status: halted`.

Runs end in a terminal state (`killed`, §3.3). A killed run cannot be resumed. Recovery means a new run, and a new
run needs a fresh authorisation review.

## 2. Scopes

| Scope | API accepts it | Needs | Reference |
|---|---|---|---|
| `run` | yes | `scopeRefId` = the run id | `kill:trigger` |
| `asset` | yes | `scopeRefId` = the asset id | `kill:trigger` |
| `tenant` | yes | no `scopeRefId`; the caller's own tenant | `kill:trigger` |
| `global` | **no.** The domain model has the scope, but `KILL_API_SCOPES` excludes it and the API rejects it. | `platform:global_kill` (exists in RBAC, no route uses it yet) | - |

So an operator **cannot yet trigger a global kill** through the product. A platform-wide stop today means one
`tenant` kill per tenant, or an infrastructure action (see [incident-response.md](incident-response.md), common
incident "runaway agents"). Treat this as a known gap for the launch review.

## 3. Triggering a kill

Every kill is audited (§8.8). Requests need a session (console, via the BFF) or a `bw_pat_` / `bw_ci_` bearer token (§9).

```http
POST /v1/kill
Idempotency-Key: <client-generated unique key>
Content-Type: application/json

{ "scope": "run", "scopeRefId": "<run uuid v7>", "reason": "SOC request INC-1234" }
```

- `reason` is required, is at most `LIMITS.reasonMax` characters, and is at least 3 characters after trimming.
- The response is `202 Accepted`, with `Location: /v1/kill/<killEventId>` and `Cache-Control: no-store`. The
  propagation runs asynchronously, so `202` means the kill was **recorded**, not that it has finished.
- Re-sending the same `Idempotency-Key` does not create a second kill event.
- Errors are RFC 9457 problem+json. Use `traceId` from the response when you raise an incident.

To read progress:

```http
GET /v1/kill/<killEventId>
```

The body gives the event `status`, the `egress` outcome (`blocked`, `already_blocked` or `failed`) and the
`sandbox` outcome. Poll it until `status` is final.

**SOC login-free link: not yet exposed.** The data model (`soc_kill_tokens`, `soc_contacts`) and the contracts
exist, but no route issues or redeems a signed link. Until that route ships, SOC staff use the console or ask an
operator to trigger the kill.

## 4. Halt times and how to verify them

Expected halt time is the §8.5 target: egress block < 2 s p99, sandbox stop < 10 s p99. Verify it from the
telemetry that exists today:

| Signal | Name | Meaning |
|---|---|---|
| Trigger latency | `bw_kill_trigger_latency_ms{scope}` | API request to 202 (not the halt time) |
| Stage latency | `bw_kill_stage_latency_ms{stage}` | Stage start to recorded outcome (`egress`, `sandbox`); the halt-time signal |
| Stage outcome | `bw_kill_stage_result_total{stage,result}` | Outcomes per stage |
| Partial halt | `bw_kill_partial_halt_total{stage}` | Any increase means a partially halted kill; page |
| Sandboxes stopped | `bw_kill_sandboxes_terminated_total` | Sandboxes confirmed gone |
| Kill events | `bw_kill_events_total{scope,source,status}` | Kill events by scope and status |
| Enqueue failures | `bw_kill_enqueue_failures_total{scope}` | The reconciler retries these; any sustained rise is an incident |
| Audit failures | `bw_kill_audit_failures_total{action}` | The kill goes on, but the ledger is missing an event; page |
| Egress readiness | `egress_ready`, `egress_up` | Gateway health (fail-closed signals) |

Audit actions to find for a kill: `kill.fired` and `kill.completed` (§8.8).

**Dashboards and alerts.** The only Grafana dashboard in the repo is the starter `Blackwing overview`
(uid `bw-overview`, `infra/compose/obs/grafana/dashboards/blackwing-overview.json`). Its runs-started and
agent-sessions panels read placeholder metrics that the product does not export yet, so do not read them as
evidence. There is **no kill dashboard and no alert rule** in the repo yet. The kill panels and the
`bw_kill_partial_halt_total` alert belong to OBS and must exist before this runbook is validated.

## 5. Procedure: running a kill

1. Confirm the scope with the requester, and record the reason in the ticket.
2. Trigger the kill with `POST /v1/kill` (section 3). Note the `killEventId`.
3. Poll `GET /v1/kill/<killEventId>` until it is final.
4. Check the egress outcome is `blocked` or `already_blocked`, and the sandbox outcome shows every target
   terminated. If either is `failed`, go to section 6.
5. Check `kill.completed` appears in the audit ledger for the event.
6. Record the halt time from `bw_kill_stage_latency_ms` for the `egress` and `sandbox` stages on the incident
   record.

## 6. Troubleshooting a partial halt or a breached halt time

Symptoms: `bw_kill_partial_halt_total` increments; a kill sits in `initiated`; an egress or sandbox outcome is
`failed`; `bw_kill_stage_latency_ms` shows a value over 2 s (egress) or 10 s (sandbox).

1. Find the failing stage with `GET /v1/kill/<killEventId>`.
2. **Egress failed.** The gateway still fails closed, so runs cannot reach targets. Check `egress_ready`
   and `egress_up`, then the gateway logs. Do not restart the gateway while a run may still be sending traffic
   without first confirming the block is in place.
3. **Sandbox failed.** Check the sandbox controller and the node that hosts the sandbox. Do not remove a
   sandbox by hand before its termination is recorded, because the audit trail needs the termination
   acknowledgement.
4. **Enqueue failed** (`bw_kill_enqueue_failures_total`). The kill event stays `initiated`, and the reconciler
   (KILL-004) re-enqueues it. Check the reconciler, and escalate if the event is still `initiated` after the
   reconciler interval.
5. **Halt time breached but completed.** Record the measured value, and raise a follow-up. A breach is a
   finding against §8.5, not a reason to change the target.
6. If the halt cannot be confirmed, escalate to SEV1 (see [incident-response.md](incident-response.md)).

## 7. Post-kill recovery

- Killed runs stay killed. Do not try to resume them.
- Confirm no sandboxes for the scope remain and no egress identity is still allowed.
- The requester starts a new run through the normal authorisation flow.
- If the kill was a false alarm, it still stays in the audit ledger. Record the reason for the close in the
  ticket, and do not delete or edit the kill event.

## Validation

Before `last_validated` can change from `never`, all of the following must be done and their records filed:

1. **Kill drill against §8.5** (staging, real sandboxes and gateway): trigger a run kill and a tenant kill, then
   measure egress and sandbox stage latency. Pass when p99 is < 2 s and < 10 s over at least 30 kills. Record
   the numbers in the drill ticket.
2. **Cross-check the KILL chaos test** against these numbers. **Not present in the repo yet.** The drill is not
   complete until that test exists and passes.
3. **Partial-halt drill:** force one egress failure and confirm the kill still records `partially_halted` and
   the sandbox stage still runs.
4. **Audit check:** confirm `kill.fired` and `kill.completed` exist for every drill kill.

When all four pass, set `last_validated` to the drill date and link the drill ticket here.
