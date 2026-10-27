import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { createOutboxDispatchers, notificationJobId } from './dispatchers.js';
import { makeRow, TENANT } from './testing.js';

const mocks = vi.hoisted(() => ({
  withTenant: vi.fn(),
  append: vi.fn(),
}));

vi.mock('@blackwing/db', () => ({
  withTenant: mocks.withTenant,
}));
vi.mock('@blackwing/audit', () => ({ appendAuditOutboxPayload: mocks.append }));

const appDb = { name: 'app' } as never;
const tx = { execute: vi.fn() };

function setup() {
  const added: unknown[] = [];
  const signals: { workflowId: string; runId: string | undefined; name: string; arg: unknown }[] =
    [];
  const dispatchers = createOutboxDispatchers({
    appDb,
    notifications: {
      add: (job) => {
        added.push(job);
        return Promise.resolve();
      },
    },
    workflows: {
      getHandle: (workflowId, runId) => ({
        signal: (name, arg) => {
          signals.push({ workflowId, runId, name, arg });
          return Promise.resolve();
        },
      }),
    },
  });
  return { dispatchers, added, signals };
}

beforeEach(() => {
  mocks.withTenant.mockReset();
  mocks.append.mockReset();
  mocks.withTenant.mockImplementation(
    (_db: unknown, _tenant: string, fn: (t: unknown) => unknown) => fn(tx),
  );
  mocks.append.mockResolvedValue(undefined);
});

describe('audit.event', () => {
  it('appends the payload to the chain on the app role, under the row tenant', async () => {
    const row = makeRow({ type: 'audit.event', payload: { action: 'run.created' } });
    await setup().dispatchers['audit.event'](row);
    expect(mocks.withTenant).toHaveBeenCalledWith(appDb, TENANT, expect.any(Function));
    expect(mocks.append).toHaveBeenCalledWith(expect.anything(), { action: 'run.created' });
  });

  it('rejects when the append fails, so the row is retried', async () => {
    mocks.append.mockRejectedValueOnce(new Error('chain locked'));
    await expect(
      setup().dispatchers['audit.event'](makeRow({ type: 'audit.event' })),
    ).rejects.toThrow('chain locked');
  });
});

describe('notify.send', () => {
  it('enqueues one job per row with a deterministic, tenant-namespaced id', async () => {
    const { dispatchers, added } = setup();
    const row = makeRow({ dedupeKey: 'run:1:done' });
    await dispatchers['notify.send'](row);
    await dispatchers['notify.send'](row);
    expect(added).toHaveLength(2);
    expect(added[0]).toEqual({
      jobId: notificationJobId(TENANT, row.id, 'run:1:done'),
      tenantId: TENANT,
      data: row.payload,
    });
    expect(added[0]).toEqual(added[1]);
  });

  it('builds ids BullMQ accepts (no colon) that differ by tenant and fall back to the row id', () => {
    const a = notificationJobId(TENANT, 'r1', 'k');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(notificationJobId('0190a000-0000-7000-8000-000000000002', 'r1', 'k')).not.toBe(a);
    expect(notificationJobId(TENANT, 'r1', null)).toBe(notificationJobId(TENANT, 'r1', null));
    expect(notificationJobId(TENANT, 'r1', null)).not.toBe(notificationJobId(TENANT, 'r2', null));
  });

  it('rejects when the queue is down', async () => {
    const dispatchers = createOutboxDispatchers({
      appDb,
      notifications: { add: () => Promise.reject(new Error('valkey down')) },
      workflows: { getHandle: () => ({ signal: () => Promise.resolve() }) },
    });
    await expect(dispatchers['notify.send'](makeRow())).rejects.toThrow('valkey down');
  });
});

describe('temporal.signal', () => {
  it('signals the workflow with a dedupe envelope', async () => {
    const { dispatchers, signals } = setup();
    const row = makeRow({
      type: 'temporal.signal',
      dedupeKey: 'gate-1',
      payload: { workflowId: 'run-1', signal: 'gateDecided', input: { approved: true } },
    });
    await dispatchers['temporal.signal'](row);
    expect(signals).toEqual([
      {
        workflowId: 'run-1',
        runId: undefined,
        name: 'gateDecided',
        arg: { dedupeKey: 'gate-1', input: { approved: true } },
      },
    ]);
  });

  it('targets a specific run when given, and falls back to the row id as dedupe key', async () => {
    const { dispatchers, signals } = setup();
    const row = makeRow({
      type: 'temporal.signal',
      dedupeKey: null,
      payload: { workflowId: 'run-1', runId: 'r-9', signal: 'ping' },
    });
    await dispatchers['temporal.signal'](row);
    expect(signals[0]).toEqual({
      workflowId: 'run-1',
      runId: 'r-9',
      name: 'ping',
      arg: { dedupeKey: row.id },
    });
  });

  it.each([
    ['no workflow id', { signal: 'x' }],
    ['no signal name', { workflowId: 'w' }],
    ['empty names', { workflowId: '', signal: '' }],
    ['unknown keys', { workflowId: 'w', signal: 's', extra: 1 }],
    ['an overlong name', { workflowId: 'w'.repeat(256), signal: 's' }],
  ])('rejects a malformed payload (%s) without calling Temporal', async (_name, payload) => {
    const { dispatchers, signals } = setup();
    await expect(
      dispatchers['temporal.signal'](makeRow({ type: 'temporal.signal', payload })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(signals).toHaveLength(0);
  });

  it('rejects when Temporal is down', async () => {
    const dispatchers = createOutboxDispatchers({
      appDb,
      notifications: { add: () => Promise.resolve() },
      workflows: { getHandle: () => ({ signal: () => Promise.reject(new Error('unavailable')) }) },
    });
    await expect(
      dispatchers['temporal.signal'](
        makeRow({ type: 'temporal.signal', payload: { workflowId: 'w', signal: 's' } }),
      ),
    ).rejects.toThrow('unavailable');
  });
});
