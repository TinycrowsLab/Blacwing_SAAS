# Workflow versioning and patching

Assessment runs last hours (recon to report), so a run started on Monday can still be open when Wednesday's worker
ships. Temporal replays a workflow's recorded history on every restart, eviction and resume. If the code no longer
issues the same commands in the same order, the workflow fails with a non-determinism error. This page is the
policy that keeps in-flight histories safe. It applies to `AssessmentRunWorkflow` and every other workflow in
`apps/worker`. It implements [ADR-0005](../adr/0005-temporal-run-lifecycle.md) and the replay discipline in
[Context Pack §3.3](CONTEXT_PACK.md#33-run-state-machine-authoritative-implement-in-packagesdomainrun). Data-layer
migrations are a separate policy (forward-only, see the DB epic).

The worked example is `apps/worker/src/workflows/examples/versioned-example.ts`. Its replay proof is
`apps/worker/src/workflows/examples/versioned-example.replay.test.ts`, which runs in `pnpm test` and therefore in CI.

## Rules

1. **Never reorder, insert or remove a command behind an existing history.** A command is an activity, timer, child
   workflow, signal or local-activity call. Order matters, not only the set of calls.
2. **Gate every behavioural change with `patched('<change-id>')`.** Use a stable, descriptive change id, for example
   `assessment-run-review-gate`. Call `patched()` unconditionally, in code order, at the point where the old and new
   behaviour diverge. Wrap the branches, never the call: `if (patched(id)) { new } else { old }` is correct, and
   `if (cond) { patched(id) }` is not, because the marker is then recorded conditionally.
3. **Retire a patch only after the drain.** Once no open history predates the patch, replace `patched(id)` with
   `deprecatePatch(id)` and keep the new branch only. Remove `deprecatePatch` after the next drain. Before the first
   step, check that the open histories are gone. The release gate is the metric
   `workflow_task_failed{reason=NonDeterminismError}`: it must stay at zero for the whole soak. Before the patch is
   retired, list the open executions of each affected workflow type and confirm that none started before the patch
   was deployed.
4. **Prefer additive signals and queries.** A new signal handler or query is safe to add. Changing an existing
   signal's payload is not, because a buffered signal from an old client is replayed against the new code.
5. **Activity signature change means a new activity name.** Do not mutate `recordReview(input)` into a different
   contract under the same name. Add `recordReviewV2`, call it behind a patch, and retire the old name with the patch.
6. **Do not use non-deterministic APIs in workflow code.** Clocks, randomness, IO and globals belong in activities.
   The determinism rules are part of ADR-0005. The enforcing lint rule is tracked by WORKFLOW-003 (#24).

### Failure modes to avoid

- **Removing a patch too early.** Histories that are still in flight need the old branch. Rule 3 mandates a drain and
  a metric check first.
- **Editing a shipped branch in place.** Changing what the old branch does, without a new patch id, makes the old
  histories non-deterministic. Add a new patch instead.

## Worker Build IDs (Worker Versioning)

Patches cover small changes. For a large migration, pin a worker build to the runs that started on it, so that
the new build never executes their histories.

- The worker declares its deployment version with `workerDeploymentOptions` (`version.deploymentName`,
  `version.buildId`, `useWorkerVersioning: true`, `defaultVersioningBehavior`). The older `buildId` and
  `useVersioning` options are deprecated in `@temporalio/worker` 1.13.
- `PINNED` keeps a workflow on the build it started on until an operator moves it. `AUTO_UPGRADE` moves it to the
  latest build at its next task. Use `PINNED` for long migrations and `AUTO_UPGRADE` for short, patched changes.
- Pin a worker to a build id for a long migration when the change cannot be patched safely: the activity contract
  changed, a whole sub-workflow was replaced, or the drain is measured in days. Keep the old build running until its
  pinned runs complete, then retire it.
- The build id is an identity, not a secret. Derive it from the release version (and never from a host name).

## Capturing a fixture

Replay tests need a real history, not a hand-written one. To capture a new fixture:

1. Start the dev stack (`pnpm dev:deps`). The Temporal server listens on `127.0.0.1:17233` (`TEMPORAL_ADDRESS`).
2. Run the previous version of the workflow on a worker against the `blackwing-dev` namespace, and let it complete.
3. Export the history with `temporal workflow show --workflow-id <id> --output json` and save it under
   `apps/worker/src/workflows/examples/fixtures/` (or the matching `fixtures/` directory of the workflow).
4. Redact `identity` fields and sticky task-queue names, which contain host names. Do not commit anything else that
   is not needed for replay. The payloads must contain no tenant data, credentials or PII.
5. Add the replay test. It must replay the fixture against the new code and must also prove a negative control: the
   same fixture fails when a command is reordered without a patch.

## Related

- [ADR-0005: Drive the run lifecycle with Temporal workflows](../adr/0005-temporal-run-lifecycle.md)
- [`dependency-graph.md`](dependency-graph.md) for what workflow code may import.
- [Context Pack §8.5 and §8.11](CONTEXT_PACK.md#8-security-invariants-every-issue-must-preserve-these-tests-must-prove-the-ones-they-touch):
  resume for the kill switch and gates must survive versioning, and no safety property may depend on the model.
