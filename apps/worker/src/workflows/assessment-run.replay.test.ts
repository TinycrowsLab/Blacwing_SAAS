// ORCH-002 (#226): determinism. The committed history was recorded from the happy path; replaying it
// against the current workflow code fails with a non-determinism error if a change breaks replay.
// After an intentional workflow change, regenerate it: BW_UPDATE_REPLAY_HISTORY=1 pnpm --filter @blackwing/worker test:int
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';

import { decodeHistory, REPLAY_HISTORY_PATH } from '../run/testing.js';

describe('AssessmentRunWorkflow replay', () => {
  it('replays the recorded happy-path history deterministically', async () => {
    const history = decodeHistory(readFileSync(REPLAY_HISTORY_PATH, 'utf8'));
    await expect(
      Worker.runReplayHistory(
        { workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)) },
        history,
      ),
    ).resolves.toBeUndefined();
  }, 120_000);
});
