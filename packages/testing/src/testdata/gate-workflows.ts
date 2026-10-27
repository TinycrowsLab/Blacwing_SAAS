// Minimal "no reply = denied" gate used to prove the time-skipping harness. Deterministic: it only awaits a
// signal or a timer, never the clock or the network.
import { condition, defineSignal, setHandler } from '@temporalio/workflow';

export const approveSignal = defineSignal('approve');

export type GateDecision = 'allowed' | 'denied';

/** Waits up to `timeoutMs` for an approve signal. No signal before the timer fires means denied. */
export async function gateWorkflow(input: { readonly timeoutMs: number }): Promise<GateDecision> {
  let approved = false;
  setHandler(approveSignal, () => {
    approved = true;
  });
  const signalled = await condition(() => approved, input.timeoutMs);
  return signalled ? 'allowed' : 'denied';
}
