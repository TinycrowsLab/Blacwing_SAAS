// Test workflows for `context.int.test.ts` (WORKFLOW #25). They are not product workflows.
import {
  condition,
  defineQuery,
  defineSignal,
  executeChild,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';

import type * as activities from './activities.js';

const { readContext } = proxyActivities<typeof activities>({ startToCloseTimeout: '10 seconds' });

export interface ProbeResult {
  readonly activity: { tenantId: string; traceId: string };
  readonly child?: ProbeResult;
}

/** Reads the context in an activity and, when asked, in a child workflow that is given no context. */
export async function contextProbeWorkflow(input: {
  sleepMs: number;
  withChild: boolean;
}): Promise<ProbeResult> {
  const activity = await readContext(input.sleepMs);
  if (!input.withChild) return { activity };
  const child = await executeChild(contextProbeWorkflow, {
    args: [{ ...input, withChild: false }],
  });
  return { activity, child };
}

export const pokeSignal = defineSignal('poke');
export const pokesQuery = defineQuery<number>('pokes');

/** Completes after one `poke` signal that the tenant gate lets through. */
export async function signalGateWorkflow(): Promise<number> {
  let pokes = 0;
  setHandler(pokeSignal, () => {
    pokes += 1;
  });
  setHandler(pokesQuery, () => pokes);
  await condition(() => pokes > 0);
  return pokes;
}
