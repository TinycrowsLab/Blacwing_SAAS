// ORCH-009 (#238) integration: PostExecutionWorkflow on a real Temporal worker with the real activities
// over in-memory ports (VALIDATE, reporting and coverage are stubbed). Needs `pnpm dev:deps`
// (temporal + temporal-bootstrap). TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ANALYST,
  CONFIRMED_VERDICT,
  FakeCoverage,
  FakeSessions,
  FakeValidator,
  MemoryFindings,
  REF,
  REQUESTER,
  makeActivities,
  makeHarness,
  type Harness,
} from './testing.js';
import {
  GATE3_RELEASED_SIGNAL,
  POST_EXECUTION_PROGRESS_QUERY,
  POST_EXECUTION_WORKFLOW,
  type Gate3ReleaseSignal,
  type PostExecutionProgress,
  type PostExecutionResult,
} from './types.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';
const POLL_MS = 100;

describe('PostExecutionWorkflow on Temporal', () => {
  let connection: Connection;
  let native: NativeConnection;
  let client: Client;

  beforeAll(async () => {
    connection = await Connection.connect({ address });
    native = await NativeConnection.connect({ address });
    client = new Client({ connection, namespace });
  });

  afterAll(async () => {
    await connection.close();
    await native.close();
  });

  /** Runs the workflow, waits for Gate 3, sends `signals`, and returns the outcome (or the failure). */
  async function run(
    h: Harness,
    signals: readonly Gate3ReleaseSignal[],
    opts: { gate3PageAfterMs?: number; signalDelayMs?: number } = {},
  ): Promise<PostExecutionResult | Error> {
    const taskQueue = `bw-postexec-${randomUUID()}`;
    const worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../../workflows/index.ts', import.meta.url)),
      activities: makeActivities(h),
    });
    return worker.runUntil(async () => {
      const handle = await client.workflow.start(POST_EXECUTION_WORKFLOW, {
        taskQueue,
        workflowId: `postexec-${randomUUID()}`,
        args: [{ ...REF, gate3PageAfterMs: opts.gate3PageAfterMs }],
      });
      for (;;) {
        const p = await handle.query<PostExecutionProgress>(POST_EXECUTION_PROGRESS_QUERY);
        if (p.phase !== 'validating') break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      await new Promise((r) => setTimeout(r, opts.signalDelayMs ?? 0));
      for (const s of signals) await handle.signal(GATE3_RELEASED_SIGNAL, s);
      try {
        return (await handle.result()) as PostExecutionResult;
      } catch (err) {
        if (err instanceof WorkflowFailedError) return err;
        throw err;
      }
    });
  }

  const release = (...ids: string[]): Gate3ReleaseSignal => ({
    actorId: ANALYST,
    decisions: ids.map((findingId) => ({ findingId, decision: 'released' as const })),
  });

  it('confirmed vs suspected: only confirmed reach Gate 3, then reporting completes the run', async () => {
    const h = makeHarness({
      findings: new MemoryFindings({ ok: 'candidate', weak: 'candidate', noisy: 'candidate' }),
      validator: new FakeValidator({
        weak: { ...CONFIRMED_VERDICT, oraclePassed: false },
        noisy: { ...CONFIRMED_VERDICT, negativeControlFired: true },
      }),
    });
    const r = (await run(h, [release('ok')])) as PostExecutionResult;
    expect(r).toMatchObject({ confirmed: 1, suspected: 2, released: 1 });
    expect(h.findings.status.get('weak')).toBe('suspected');
    expect(h.findings.status.get('noisy')).toBe('suspected');
    expect(h.runs.state).toBe('completed');
    expect(h.sessions.started.map((s) => s.role).sort()).toEqual(['remediation', 'reporter']);
  });

  it('SoD: a release by the requester is refused and the run keeps waiting for someone else', async () => {
    const h = makeHarness({
      findings: new MemoryFindings({ f: 'candidate' }),
      permissions: { canRelease: () => Promise.resolve(true) },
    });
    const r = (await run(h, [
      { actorId: REQUESTER, decisions: [{ findingId: 'f', decision: 'released' }] },
      release('f'),
    ])) as PostExecutionResult;
    expect(r.released).toBe(1);
    expect(h.findings.decisions.map((d) => d.actorId)).toEqual([ANALYST]);
  });

  it('zero candidates: awaits Gate 3 with an empty set, still finalises coverage', async () => {
    const h = makeHarness();
    const r = (await run(h, [release()])) as PostExecutionResult;
    expect(r).toMatchObject({ confirmed: 0, suspected: 0, released: 0 });
    expect(h.coverage.finalised).toBe(true);
    expect(h.runs.state).toBe('completed');
  });

  it('the run cannot complete without a finalised coverage manifest', async () => {
    const coverage = new FakeCoverage();
    coverage.broken = true;
    const h = makeHarness({ coverage });
    const r = await run(h, [release()]);
    expect(r).toBeInstanceOf(WorkflowFailedError);
    expect(h.runs.state).toBe('reporting');
  });

  it('a failing reporter session fails the phase but keeps the finding released', async () => {
    const h = makeHarness({
      findings: new MemoryFindings({ f: 'candidate' }),
      sessions: new FakeSessions('reporter'),
    });
    const r = await run(h, [release('f')]);
    expect(r).toBeInstanceOf(WorkflowFailedError);
    expect(h.findings.status.get('f')).toBe('released');
  }, 120_000);

  it('Gate 3 timeout pages and never auto-releases; a later decision still completes', async () => {
    const h = makeHarness({ findings: new MemoryFindings({ f: 'candidate' }) });
    const r = (await run(h, [release('f')], {
      gate3PageAfterMs: 50,
      signalDelayMs: 1500,
    })) as PostExecutionResult;
    expect(r.gate3Pages).toBeGreaterThan(0);
    expect(h.pager.pages.length).toBeGreaterThan(0);
    expect(h.findings.decisions).toHaveLength(1);
  });
});
