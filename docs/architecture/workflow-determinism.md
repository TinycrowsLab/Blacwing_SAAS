# Workflow determinism

Temporal replays workflow code from its recorded history whenever a worker restarts or a workflow is resumed.
A replay must make the same decisions as the original run. Any code that reads the wall clock, randomness,
the environment or the network can take a different branch on replay. That corrupts run history and breaks the
kill and resume guarantees in [CONTEXT_PACK §8.5 and §8.11](./CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch).

These rules apply to `apps/worker/src/workflows/`. The mechanical ones are enforced by ESLint (`pnpm lint`,
override `blackwing/workflow-determinism` in `eslint.config.mjs`). The rest are review rules. Versioning and
patching are a separate policy (WORKFLOW-007).

## Allowed and banned APIs in a workflow

| Need | Use in a workflow | Banned in a workflow | Why |
|---|---|---|---|
| Current time | `workflowInfo().startTime`, or an activity that reads the clock and returns the value (recorded in history) | `Date.now()`, `new Date()`, `Date()` | The sandbox overrides `Date` with workflow time. Authors must not depend on that override. `new Date(value)` with an explicit value is fine. |
| Delay or timeout | `sleep()` from `@temporalio/workflow`, `condition()` with a timeout | `setTimeout`, `setInterval`, `setImmediate` | Only SDK timers are recorded in history and replay. |
| Randomness and IDs | `uuid4()` from `@temporalio/workflow` | `Math.random`, `crypto` (the global and `node:crypto`) | `uuid4()` is derived from the workflow's deterministic random source. |
| Configuration and environment | Workflow input, or read it inside an activity through `@blackwing/config` | `process`, `process.env`, `node:process` | Workers differ in their environment, so replays would differ. |
| Network | An activity, called through `proxyActivities` | `fetch`, Node built-ins such as `node:http`, `node:net`, `node:dns` | Network access is I/O. |
| Filesystem and subprocesses | An activity | `node:fs`, `node:child_process` and every other Node built-in | I/O. |
| Database, Redis, Temporal client | An activity (database access goes through `withTenant`) | `pg`, `ioredis`, `@temporalio/client` | I/O. A workflow never starts or signals workflows. |

Type-only imports are always allowed (`import type { … }`). They are erased at build time and cannot run.

## Ordering

- Build the input array of each `Promise.all` in a fixed order. Sort an unordered source (a `Set`, object keys
  from input) before fanning out.
- Read results by input index, never by completion order.
- Do not decide anything from which promise settles first. Only the order of Temporal events is deterministic.

## Side effects belong in activities

Any effect outside the workflow happens in an activity: sending a request, writing a row, reading the clock
for a stored decision, or calling a connector. Activities retry, so they must be idempotent (compare-and-set,
as in the kill coordinator). The workflow only schedules them and reads their recorded results.

## Shared modules: split pure from impure

A helper used by both workflows and activities is split in two:

- a pure module (types, constants, pure functions) that workflows may import, and
- an impure module (I/O, clients, clock reads) that only activities import.

The workflow override matches files under `apps/worker/src/workflows/`. A module outside that folder is not
linted with these rules when a workflow imports it, so keep modules reached from a workflow pure. The bundle
entry `apps/worker/src/workflows/index.ts` is where that graph starts and is reviewed.

## Example: a timer that fails lint, and its fix

```ts
// Before: `Date.now()` and `setTimeout` both fail `pnpm lint` in a workflow file.
const deadline = Date.now() + input.ttlMs;
await new Promise((resolve) => setTimeout(resolve, input.ttlMs));

// After: the SDK timer is recorded in history and replays exactly. No wall-clock deadline is needed.
await sleep(input.ttlMs);
```

The same two calls are fine in an activity file (for example `apps/worker/src/kill/activities.ts`), which is
where a clock read or a timer belongs when its effect is real.

## Enforcement

- `pnpm lint` fails on any banned call in `apps/worker/src/workflows/**/*.ts`. The rules run with type information.
- `scripts/lint-config.test.mjs` (`workflow determinism`) proves that each banned call fails in a workflow
  file and passes in an activity file, and that `import type` and `uuid4()` pass.
- Do not add an `eslint-disable` comment to get past a workflow rule. If a rule is wrong, change the rule and
  this document in the same change, and link the issue that justifies it.
