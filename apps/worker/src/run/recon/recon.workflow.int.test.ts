// ORCH-004 (#228) integration: ReconWorkflow on a real Temporal worker with the real activities over
// in-memory ports and a stubbed AgentSessionWorkflow. Needs `pnpm dev:deps` (temporal + temporal-bootstrap).
// TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createReconActivities } from './activities.js';
import {
  FakeSurface,
  MemoryRunRepo,
  REF,
  makeFacts,
  makeHarness,
  type Harness,
} from './testing.js';
import { RECON_WORKFLOW, type ReconDecision, type ReconSessionInput } from './types.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';

describe('ReconWorkflow on Temporal', () => {
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

  async function run(
    h: Harness,
    crashing: readonly string[] = [],
  ): Promise<{ decision: ReconDecision; started: ReconSessionInput[] }> {
    const taskQueue = `bw-recon-${randomUUID()}`;
    const started: ReconSessionInput[] = [];
    const worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('./stub-workflows.int.ts', import.meta.url)),
      activities: {
        ...createReconActivities(h.deps),
        stubSession: (input: ReconSessionInput) => {
          started.push(input);
          if (crashing.includes(input.persona)) throw new Error('crash');
          return Promise.resolve({ sessionId: input.sessionId, status: 'completed', costUsd: 0.1 });
        },
      },
    });
    const decision = (await worker.runUntil(
      client.workflow.execute(RECON_WORKFLOW, {
        taskQueue,
        workflowId: `recon-${randomUUID()}`,
        args: [{ ...REF, maxAttempts: 2 }],
      }),
    )) as ReconDecision;
    return { decision, started };
  }

  const personas = (started: ReconSessionInput[]): string[] => started.map((s) => s.persona).sort();

  it('black box starts exactly passive-recon, osint, active-recon, threat-intel', async () => {
    const { decision, started } = await run(makeHarness());
    expect(personas(started)).toEqual(['active-recon', 'osint', 'passive-recon', 'threat-intel']);
    expect(decision.event).toBe('recon_complete');
    for (const s of started) expect(s.intrusiveness).not.toBe('state_changing');
  });

  it('grey box starts active-recon, threat-intel, source-spec-ingestion, session-setup', async () => {
    const repo = new MemoryRunRepo(makeFacts({ mode: 'grey', manifestSuppliesSurface: true }));
    const { started } = await run(makeHarness({ repo }));
    expect(personas(started)).toEqual([
      'active-recon',
      'session-setup',
      'source-spec-ingestion',
      'threat-intel',
    ]);
  });

  it('white box starts source-spec-ingestion, threat-intel, session-setup, minimal active-recon', async () => {
    const repo = new MemoryRunRepo(makeFacts({ mode: 'white', manifestSuppliesSurface: true }));
    const { started } = await run(makeHarness({ repo }));
    expect(personas(started)).toEqual([
      'active-recon',
      'session-setup',
      'source-spec-ingestion',
      'threat-intel',
    ]);
    expect(started.find((s) => s.persona === 'active-recon')?.minimal).toBe(true);
  });

  it('one crashing persona still lets the phase complete', async () => {
    const { decision } = await run(makeHarness(), ['osint']);
    expect(decision.event).toBe('recon_complete');
    expect(decision.sessions.find((s) => s.persona === 'osint')?.outcome).toBe('failed');
  });

  it('every persona crashing fails the run', async () => {
    const { decision } = await run(makeHarness(), [
      'passive-recon',
      'osint',
      'active-recon',
      'threat-intel',
    ]);
    expect(decision).toMatchObject({
      event: 'fail',
      statusReason: 'recon_failed:RECON_ALL_SESSIONS_FAILED',
    });
  });

  it('an empty black-box surface fails with RECON_EMPTY_SURFACE', async () => {
    const h = makeHarness({ surface: new FakeSurface({ hosts: 0, endpoints: 0 }) });
    const { decision } = await run(h);
    expect(decision.statusReason).toBe('recon_failed:RECON_EMPTY_SURFACE');
  });
});
