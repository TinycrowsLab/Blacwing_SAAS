// WORKFLOW-008 replay proof. The fixture is a v1 history captured from a real Temporal dev server (see
// docs/architecture/workflow-versioning.md#capturing-a-fixture). Replay is offline: no server, no activities run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Worker } from '@temporalio/worker';
import { DeterminismViolationError } from '@temporalio/workflow';
import { describe, expect, it } from 'vitest';

const v1History: unknown = JSON.parse(
  readFileSync(new URL('./fixtures/versioned-example.v1.history.json', import.meta.url), 'utf8'),
);

const guardedWorkflows = fileURLToPath(new URL('./versioned-example.ts', import.meta.url));
const unpatchedWorkflows = fileURLToPath(
  new URL('./versioned-example.unpatched.ts', import.meta.url),
);

describe('versionedExample replay', () => {
  it('replays the captured v1 history against the patched v2 code without a non-determinism error', async () => {
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: guardedWorkflows },
        v1History,
        'versioned-example-v1',
      ),
    ).resolves.toBeUndefined();
  }, 60_000);

  // The SDK keeps one shared Runtime. The previous replay worker may still be shutting it down, so
  // this replay can reach a closing runtime (TypeError from replay_worker_new) before any workflow
  // runs. The same assertion is re-run on a fresh replay worker; it is not relaxed.
  it(
    'detects the same v1 history when the review step is inserted without patched()',
    { timeout: 60_000, retry: 2 },
    async () => {
      // Negative control: proves the replay above can fail. Without the patch the command order changes.
      const replay = Worker.runReplayHistory(
        { workflowsPath: unpatchedWorkflows },
        v1History,
        'versioned-example-v1-unpatched',
      );
      await expect(replay).rejects.toBeInstanceOf(DeterminismViolationError);
    },
  );

  it('fails closed on a history that is not a valid Temporal history', async () => {
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: guardedWorkflows },
        null,
        'versioned-example-invalid',
      ),
    ).rejects.toThrow(TypeError);
  }, 60_000);
});
