---
last_validated: never
---

# Kill SLO chaos suite runbook (KILL-008, §8.5)

Owner: KILL. Read with [kill-switch.md](kill-switch.md), which describes the kill stages, and with the §8.5 kill
SLO and §8.2 fail-closed egress invariants in the Context Pack.

> **Status: not yet validated.** `last_validated: never` is the truth until the real-stack run in
> [Validation](#validation) has passed against the dev stack and its record is filed. The mock suite runs in CI
> today; the live-stack run does not.

## 1. What the suite proves

The suite fires a fleet of kills through the real propagation code (`apps/worker/src/kill/propagate.ts` and the
kill activities) over the real HTTP control adapters. It runs in `apps/worker/src/kill/chaos/`.

| Check | Test | Budget or invariant |
|---|---|---|
| Load: `KILL_CHAOS_RUNS` runs (default 25) across 2 tenants and 4 assets, with a kill per run, per asset and per tenant | `halts every kill and keeps the egress and full-halt p99 inside budget` | every kill ends `halted` |
| Egress block p99 | same test, from the egress stage latency | p99 < 2 000 ms (§8.5) |
| Full halt p99 | same test, from the server-side halt time | p99 < 10 000 ms (§8.5) |
| Egress ack lost after the block applied | `kill.chaos.failclosed: egress ack lost ...` | ends `partially_halted`; post-block traffic denied (§8.2) |
| Egress unreachable | `kill.chaos.failclosed: egress unreachable ...` | gateway fails closed; ends `partially_halted`; traffic denied |
| Sandbox terminate ack fails | `a sandbox terminate ack failure ...` | `partially_halted`; egress blocked and keys revoked |
| Key revoke ack fails | `a key revoke ack failure ...` | `partially_halted`; egress blocked and sandboxes gone |
| Egress ack delayed past 2 s | `a delayed egress ack past the 2 s budget ...` | traffic denied before the ack arrives |

Timing assertions use real timers. Retries are disabled (`retry: 0`) on purpose: a timing test must never pass
on a second attempt. Do not add retries to `vitest.chaos.config.ts`.

## 2. Running it

The suite is not part of `pnpm test`, so it never runs on a pull request. It runs in the `kill-slo` workflow
(`.github/workflows/kill-slo.yml`) nightly and on `workflow_dispatch`.

Locally, from the repository root:

```sh
pnpm --filter @blackwing/worker test:chaos
```

| Variable | Default | Meaning |
|---|---|---|
| `KILL_CHAOS_MODE` | `mock` | `mock` starts an in-process control plane. `real` targets the live stack. |
| `KILL_CHAOS_RUNS` | `25` | Non-terminal runs seeded for the load scenario (1 to 500). |
| `KILL_CHAOS_EGRESS_URL`, `KILL_CHAOS_SANDBOX_URL`, `KILL_CHAOS_KEYS_URL` | unset | Live control-plane base URLs. All three are required in `real` mode, and the suite refuses to start without them. |
| `KILL_CHAOS_REPORT_PATH` | `eval/harness/out/kill-slo-report.json` | Where the JSON SLO report is written. |

The fault-injection cases and the traffic checks need the mock control plane, so they are skipped in `real` mode.
`real` mode runs only the load scenario against the live services.

**Minimum host.** The default run count fires 31 kills at once (25 run, 4 asset and 2 tenant scope) in one
process. A machine that also runs the full dev stack should lower `KILL_CHAOS_RUNS` (for example to `10`) instead
of skipping the suite. Record the value used in the report.

## 3. Reading the report

The report is written to `eval/harness/out/kill-slo-report.json` (and uploaded as the `kill-slo-report` artifact in
CI). Its fields:

- `killStatuses`: the count of kills per final status. `pass` needs every fired kill to be `halted`.
- `latency.egress_block` and `latency.full_halt`: `count`, `p50Ms`, `p95Ms`, `p99Ms` and `maxMs`, measured from
  server-side timestamps only.
- `budgets` and `breaches`: the §8.5 budgets, and any metric whose p99 reached its budget.
- `pass`: `true` only when there are no breaches and every fired kill is `halted`.

When a budget is breached, the test fails with a message such as
`kill SLO budget breached: egress_block p99 2500 ms >= budget 2000 ms`. Read the report before rerunning.

Percentiles use the nearest-rank method. With 31 kills, p99 is the slowest sample, so one slow kill is enough to
breach the budget. Treat a single breach as a signal to investigate, not as noise to retry away.

## 4. When the suite fails

1. Open the report and find which metric breached, and which kill statuses are not `halted`.
2. If a fault case fails, it names the invariant in its title. A `kill.chaos.failclosed` failure means traffic
   may have been possible after an egress block: treat it as a security incident, not a test flake
   ([kill-switch.md](kill-switch.md), section 6).
3. For a latency breach, check the stage metrics the suite reads: `bw_kill_stage_latency_ms{stage}` and
   `bw_kill_halt_ms`. A sustained rise on a live stack points at the gateway, the sandbox controller or the
   database, not at the suite.
4. Do not raise a budget to make the suite pass. The budgets are §8.5 targets. Changing one needs a Context Pack
   change first.

## Validation

The procedure below is the check that moves this runbook to a dated `last_validated`.

1. Confirm the mock suite is green on `main`: the `kill-slo` workflow run for the commit shows `pass: true` in its
   artifact.
2. Start the dev stack (`pnpm dev:deps`), and point the suite at its live control APIs:
   `KILL_CHAOS_MODE=real KILL_CHAOS_EGRESS_URL=... KILL_CHAOS_SANDBOX_URL=... KILL_CHAOS_KEYS_URL=...
   pnpm --filter @blackwing/worker test:chaos`.
3. Confirm `pass: true` in the report, with `killStatuses` showing only `halted`.
4. File the report with the date and the commit SHA, then set `last_validated` to that date.
