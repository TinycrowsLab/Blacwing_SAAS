// ORCH-003 (#227) integration: PreflightWorkflow on a real Temporal worker with the real activities over
// in-memory ports (the downstreams are stubbed). Needs `pnpm dev:deps` (temporal + temporal-bootstrap).
// TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPreflightActivities } from './activities.js';
import {
  FakeNotices,
  FakeSessions,
  MemoryRunRepo,
  REF,
  makeFacts,
  makeHarness,
  type Harness,
} from './testing.js';
import { PREFLIGHT_WORKFLOW, type PreflightDecision } from './types.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';

describe('PreflightWorkflow on Temporal', () => {
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

  async function run(h: Harness): Promise<PreflightDecision> {
    const taskQueue = `bw-preflight-${randomUUID()}`;
    const worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../../workflows/index.ts', import.meta.url)),
      activities: createPreflightActivities(h.deps),
    });
    return worker.runUntil(
      client.workflow.execute(PREFLIGHT_WORKFLOW, {
        taskQueue,
        workflowId: `preflight-${randomUUID()}`,
        args: [{ ...REF, maxAttemptsPerCheck: 2 }],
      }),
    ) as Promise<PreflightDecision>;
  }

  it('all checks pass: decides preflight_passed and persists the report', async () => {
    const h = makeHarness();
    const d = await run(h);
    expect(d.event).toBe('preflight_passed');
    expect(h.repo.report?.ok).toBe(true);
  });

  it('an unverified asset hard-fails with ASSET_NOT_VERIFIED', async () => {
    const facts = makeFacts({
      assets: [{ assetId: 'a', target: 't.example.com', verification: 'pending' }],
    });
    const d = await run(makeHarness({ repo: new MemoryRunRepo(facts) }));
    expect(d.event).toBe('fail');
    expect(d.statusReason).toBe('preflight_failed:verifyAssetsVerified:ASSET_NOT_VERIFIED');
  });

  it('an expired SA decides sa_expired', async () => {
    const base = makeFacts().authorisation;
    const facts = makeFacts({ authorisation: { ...base, status: 'expired' } });
    const d = await run(makeHarness({ repo: new MemoryRunRepo(facts) }));
    expect(d.event).toBe('sa_expired');
  });

  it('a closed window hard-fails with WINDOW_CLOSED', async () => {
    const d = await run(makeHarness({ repo: new MemoryRunRepo(makeFacts({ window: null })) }));
    expect(d.statusReason).toBe('preflight_failed:assertWindowOpen:WINDOW_CLOSED');
  });

  it('a failed role login hard-fails naming the role', async () => {
    const d = await run(makeHarness({ sessions: new FakeSessions(['user']) }));
    expect(d.statusReason).toBe('preflight_failed:loginPerRole:ROLE_LOGIN_FAILED');
  });

  it('a SOC notice failure hard-fails', async () => {
    const d = await run(makeHarness({ notices: new FakeNotices('failed') }));
    expect(d.statusReason).toBe('preflight_failed:deliverSocNotice:SOC_NOTICE_FAILED');
  });
});
