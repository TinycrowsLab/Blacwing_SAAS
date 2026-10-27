// KILL-006 (#176) integration: the real KillPropagationWorkflow on a TS SDK worker against the dev
// Temporal (`pnpm dev:deps`; TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE override), with a real HTTP mock of the
// model-gateway revoke endpoint and the real Temporal cancel adapter. Egress, sandbox, audit and the
// kill_events row are in-memory fakes (their own suites cover the real adapters).
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { Client, Connection, WorkflowFailedError } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createKillActivities, type KillActivityDeps } from './activities.js';
import { createHttpKeyControlClient, KEYS_REVOKE_PATH } from './key-client.js';
import {
  ackAll,
  FakeGateway,
  FakeSandboxController,
  makeDeps,
  MemoryKillRepo,
  KILL_ID,
  RUN_ID,
  runIdentity,
  TENANT,
} from './testing.js';
import {
  KILL_PROPAGATION_WORKFLOW,
  KILL_TARGETS_SIGNAL,
  type KillPropagationRequest,
} from './types.js';
import { createTemporalWorkflowControlClient } from './workflow-client.js';

import type { victimWorkflow } from './kill-int-workflows.js';

const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:17233';
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'blackwing-dev';
const taskQueue = `bw-kill-${randomUUID()}`;
const KEYS = ['key-1', 'key-2'];

describe('KillPropagationWorkflow key revoke and workflow cancel', () => {
  let connection: Connection;
  let native: NativeConnection;
  let client: Client;
  let gateway: Server;
  let gatewayUrl = '';
  let revokeCalls: { keyIds: string[] }[] = [];
  let gatewayStatus = 200;

  beforeAll(async () => {
    connection = await Connection.connect({ address });
    native = await NativeConnection.connect({ address });
    client = new Client({ connection, namespace });
    gateway = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { keyIds: string[] };
        res.setHeader('content-type', 'application/json');
        if (req.url !== KEYS_REVOKE_PATH || gatewayStatus !== 200) {
          res.statusCode = gatewayStatus === 200 ? 404 : gatewayStatus;
          res.end('{}');
          return;
        }
        // The first call for a key revokes it; later calls are the idempotent ack.
        const seen = revokeCalls.flatMap((c) => c.keyIds);
        revokeCalls.push({ keyIds: body.keyIds });
        res.end(
          JSON.stringify({
            acks: body.keyIds.map((keyId) => ({
              keyId,
              outcome: seen.includes(keyId) ? 'already_revoked' : 'revoked',
            })),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    const addr = gateway.address();
    gatewayUrl = `http://127.0.0.1:${String(typeof addr === 'object' && addr !== null ? addr.port : 0)}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => gateway.close(resolve));
    await connection.close();
    await native.close();
  });

  async function runKill(
    repo: MemoryKillRepo,
    victimId: string,
    overrides: Partial<KillActivityDeps> = {},
  ): Promise<void> {
    const { deps } = makeDeps(repo, new FakeGateway((i) => ackAll(i)), {
      sandboxes: new FakeSandboxController(),
      keys: createHttpKeyControlClient({ baseUrl: gatewayUrl }),
      workflows: createTemporalWorkflowControlClient(client.workflow),
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...overrides,
    });
    const worker = await Worker.create({
      connection: native,
      namespace,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('./kill-int-workflows.ts', import.meta.url)),
      activities: createKillActivities(deps),
    });
    const request: KillPropagationRequest = {
      killEventId: KILL_ID,
      tenantId: TENANT,
      scope: 'tenant',
      scopeRefId: null,
      triggeredAt: repo.event.triggeredAt.toISOString(),
      targets: {
        runIds: [RUN_ID],
        sessionIds: [],
        sandboxIds: ['sbx-1'],
        virtualKeyIds: KEYS,
        egressIdentities: [runIdentity(RUN_ID)],
        workflowIds: [victimId, `missing-${randomUUID()}`],
      },
    };
    await worker.runUntil(async () => {
      const handle = await client.workflow.start(KILL_PROPAGATION_WORKFLOW, {
        taskQueue,
        workflowId: `kill-${randomUUID()}`,
        args: [{ killEventId: KILL_ID, tenantId: TENANT }],
      });
      await handle.signal(KILL_TARGETS_SIGNAL, request);
      await handle.result();
    });
  }

  async function startVictim(): Promise<string> {
    const workflowId = `victim-${randomUUID()}`;
    await client.workflow.start<typeof victimWorkflow>('victimWorkflow', {
      taskQueue,
      workflowId,
      args: [],
    });
    return workflowId;
  }

  it('revokes keys, cancels the workflow and completes halted; a re-run is a no-op', async () => {
    revokeCalls = [];
    gatewayStatus = 200;
    const repo = new MemoryKillRepo();
    // Queued on the task queue; the kill's worker serves it (same workflow bundle).
    const victimId = await startVictim();

    await runKill(repo, victimId);

    expect(repo.event.status).toBe('halted');
    expect(repo.event.keysRevokedAt).not.toBeNull();
    expect(repo.event.workflowsCancelledAt).not.toBeNull();
    expect(repo.event.completedAt).not.toBeNull();
    expect(repo.haltMs).toBeGreaterThanOrEqual(0);
    expect(repo.event.affected.keys).toBe(2);
    expect(revokeCalls).toEqual([{ keyIds: KEYS }]);
    const victim = client.workflow.getHandle(victimId);
    await expect(victim.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    expect((await victim.describe()).status.name).toBe('CANCELLED');

    const before = { ...repo.event };
    await runKill(repo, victimId);
    expect(repo.event).toEqual(before);
    expect(revokeCalls).toEqual([{ keyIds: KEYS }]);
  });

  it('gateway unreachable: keys stay unrevoked, the event completes partially_halted', async () => {
    revokeCalls = [];
    gatewayStatus = 503;
    const repo = new MemoryKillRepo();
    await runKill(repo, `gone-${randomUUID()}`, { keyDeadlineMs: 1_000, keyBackoffBaseMs: 100 });
    expect(repo.event.status).toBe('partially_halted');
    expect(repo.event.completedAt).not.toBeNull();
    expect(repo.event.affected.keys).toBe(0);
    expect(revokeCalls).toEqual([]);
  });
});
