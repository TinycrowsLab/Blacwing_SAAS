import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

import { runSaTimeBounds, type SaBoundsControl } from '../sa-bounds/sequence.js';
import {
  RUN_FINISHED_SIGNAL,
  SA_BOUNDS_EDITED_SIGNAL,
  SA_BOUNDS_STATUS_QUERY,
  SA_REVOKED_SIGNAL,
  type SaBoundsActivities,
  type SaBoundsStatus,
  type SaTimeBounds,
  type SaTimeBoundsInput,
} from '../sa-bounds/types.js';

const revokedSignal = defineSignal<[{ revokedAt: string }]>(SA_REVOKED_SIGNAL);
const editedSignal = defineSignal<[SaTimeBounds]>(SA_BOUNDS_EDITED_SIGNAL);
const finishedSignal = defineSignal(RUN_FINISHED_SIGNAL);
const statusQuery = defineQuery<SaBoundsStatus>(SA_BOUNDS_STATUS_QUERY);

const acts = proxyActivities<SaBoundsActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { initialInterval: '200 milliseconds', backoffCoefficient: 2, maximumAttempts: 6 },
});

// Stopping traffic is the point of this workflow, so the egress block keeps retrying much longer
// (about a minute and a half) before the sequence gives up and relies on the gateway's own check.
const blockActs = proxyActivities<Pick<SaBoundsActivities, 'blockEgress'>>({
  startToCloseTimeout: '10 seconds',
  retry: {
    initialInterval: '100 milliseconds',
    backoffCoefficient: 2,
    maximumInterval: '5 seconds',
    maximumAttempts: 20,
  },
});

/**
 * ORCH-014: enforces the standing authorisation's time bounds for one run. The run workflow starts it
 * (workflow id derived from the run id) when the run enters `preflight`; it ends when the run is
 * finished (`runFinished` signal), the SA expires or is revoked, or a window closes with none left.
 * Timers are durable: `condition(..., timeout)` is a Temporal timer, and the clock is read only inside
 * the `evaluateTimeline` activity.
 */
export async function SaTimeBoundsWorkflow(input: SaTimeBoundsInput): Promise<void> {
  const state = {
    bounds: {
      validFrom: input.validFrom,
      expiresAt: input.expiresAt,
      testWindows: input.testWindows,
    } as SaTimeBounds,
    revoked: null as { readonly revokedAt: string } | null,
    finished: false,
    version: 0,
  };
  const status = {
    current: {
      phase: 'waiting',
      expiresAt: input.expiresAt,
      windowCloseAt: null,
      nextOpenAt: null,
      stoppedFor: null,
    } as SaBoundsStatus,
  };

  setHandler(revokedSignal, (payload) => {
    state.revoked ??= payload;
    state.version += 1;
  });
  setHandler(editedSignal, (bounds) => {
    state.bounds = bounds;
    state.version += 1;
  });
  setHandler(finishedSignal, () => {
    state.finished = true;
    state.version += 1;
  });
  setHandler(statusQuery, () => status.current);

  const ctl: SaBoundsControl = {
    state,
    status,
    waitUntil: async (wake, ms) => {
      await condition(wake, ms);
    },
  };
  await runSaTimeBounds(input, { ...acts, blockEgress: blockActs.blockEgress }, ctl);
}
