import { Context } from '@temporalio/activity';

import type { ActivityRuntime } from './ports.js';

/** The running Temporal activity's heartbeat and cancellation signal. Call it inside an activity only. */
export function temporalActivityRuntime(): ActivityRuntime {
  const ctx = Context.current();
  return {
    heartbeat: () => {
      ctx.heartbeat();
    },
    cancellationSignal: ctx.cancellationSignal,
  };
}
