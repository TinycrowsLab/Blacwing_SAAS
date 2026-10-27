import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  advanceTime,
  getWorkflowResult,
  sendSignalAndSettle,
  withTestWorkflowEnv,
  type TestWorkflowEnv,
} from './temporal.js';
import { approveSignal, gateWorkflow, type GateDecision } from './testdata/gate-workflows.js';

const WORKFLOWS_PATH = fileURLToPath(new URL('./testdata/gate-workflows.ts', import.meta.url));
const AUDIT_INTERCEPTOR_PATH = fileURLToPath(
  new URL('./testdata/audit-interceptor.ts', import.meta.url),
);
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Booting the time-skipping server and bundling the workflow take seconds; the skipped timer must not. */
const HARNESS_TIMEOUT_MS = 120_000;

const run = <T>(fn: (testEnv: TestWorkflowEnv) => Promise<T>): Promise<T> =>
  withTestWorkflowEnv(fn, { workflowsPath: WORKFLOWS_PATH });

const startGate = (testEnv: TestWorkflowEnv, timeoutMs: number) =>
  testEnv.client.workflow.start(gateWorkflow, {
    args: [{ timeoutMs }],
    taskQueue: testEnv.taskQueue,
    workflowId: `gate-${randomUUID()}`,
  });

describe('withTestWorkflowEnv time-skipping harness', () => {
  it(
    'denies a gate with no reply after a 24h timer, in well under a second of wall time',
    async () => {
      const decision = await run(async (testEnv) => {
        const handle = await startGate(testEnv, DAY_MS);
        const startedAt = performance.now();
        const result = await getWorkflowResult<GateDecision>(handle);
        const wallMs = performance.now() - startedAt;
        // The 24h timer ran on the skipped clock, not on the wall clock.
        expect(wallMs).toBeLessThan(1000);
        expect(await testEnv.env.currentTimeMs()).toBeGreaterThanOrEqual(DAY_MS);
        return result;
      });
      expect(decision).toBe('denied');
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'allows a gate when the approve signal arrives before the timeout',
    async () => {
      const decision = await run(async (testEnv) => {
        const handle = await startGate(testEnv, DAY_MS);
        await sendSignalAndSettle(handle, approveSignal.name, []);
        return getWorkflowResult<GateDecision>(handle);
      });
      expect(decision).toBe('allowed');
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'advanceTime moves the skipped clock past the gate timeout, so the gate is denied',
    async () => {
      const { decision, elapsedMs } = await run(async (testEnv) => {
        const handle = await startGate(testEnv, HOUR_MS);
        const before = await testEnv.env.currentTimeMs();
        await advanceTime(testEnv, 2 * HOUR_MS);
        const outcome = await getWorkflowResult<GateDecision>(handle);
        return { decision: outcome, elapsedMs: (await testEnv.env.currentTimeMs()) - before };
      });
      expect(elapsedMs).toBeGreaterThanOrEqual(2 * HOUR_MS);
      expect(decision).toBe('denied');
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'refuses to skip a negative, fractional or unsafe amount of time',
    async () => {
      await run(async (testEnv) => {
        await expect(advanceTime(testEnv, -1)).rejects.toThrow(RangeError);
        await expect(advanceTime(testEnv, 1.5)).rejects.toThrow(RangeError);
        await expect(advanceTime(testEnv, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(RangeError);
      });
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'registers the workflow interceptor modules and the sinks they report to',
    async () => {
      const seen: string[] = [];
      await withTestWorkflowEnv(
        async (testEnv) => {
          const handle = await startGate(testEnv, DAY_MS);
          await sendSignalAndSettle(handle, approveSignal.name, []);
          await getWorkflowResult<GateDecision>(handle);
          // Sinks run on the worker after the workflow task settles, so they can land after the result is read.
          // The assertion must run inside the callback: the worker stops when the callback returns.
          await vi.waitFor(
            () => {
              expect(seen).toEqual(['started:gateWorkflow', 'completed:gateWorkflow']);
            },
            { timeout: 10_000 },
          );
        },
        {
          workflowsPath: WORKFLOWS_PATH,
          workflowInterceptorModules: [AUDIT_INTERCEPTOR_PATH],
          sinks: {
            audit: {
              record: {
                fn: (_info, kind: string, workflowType: string) => {
                  seen.push(`${kind}:${workflowType}`);
                },
                callDuringReplay: false,
              },
            },
          },
        },
      );
    },
    HARNESS_TIMEOUT_MS,
  );

  it(
    'tears the environment down and rethrows when the callback fails',
    async () => {
      await expect(run(() => Promise.reject(new Error('callback failed')))).rejects.toThrow(
        'callback failed',
      );
    },
    HARNESS_TIMEOUT_MS,
  );
});
