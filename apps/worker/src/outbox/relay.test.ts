import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOutboxRelay, TENANT_INACTIVE, type OutboxRelayDeps } from './relay.js';
import { makeClaim, makeRow, TENANT, type RecordingClaim } from './testing.js';

import type { ClaimedOutboxRow } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

const mocks = vi.hoisted(() => ({
  withOutboxClaim: vi.fn(),
  outboxBacklog: vi.fn(),
  withTenant: vi.fn(),
}));

vi.mock('@blackwing/db', () => ({
  withOutboxClaim: mocks.withOutboxClaim,
  outboxBacklog: mocks.outboxBacklog,
  withTenant: mocks.withTenant,
}));
vi.mock('./audit-tx.js', () => ({ toAuditSqlTx: (tx: unknown) => tx }));

const relayDb = { name: 'relay' } as never;
const appDb = { name: 'app' } as never;
const noop = (): void => undefined;
const silent: Logger = {
  child: () => silent,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
} as unknown as Logger;

function metricsDouble() {
  const events: string[] = [];
  return {
    events,
    metrics: {
      dispatched: (type: string) => events.push(`dispatched:${type}`),
      failed: (type: string) => events.push(`failed:${type}`),
      retried: (type: string) => events.push(`retried:${type}`),
      dispatchLatency: (s: number) => events.push(`latency:${s >= 0 ? 'ok' : 'neg'}`),
      backlog: (type: string, n: number) => events.push(`backlog:${type}=${String(n)}`),
    },
  };
}

interface Harness {
  readonly relay: ReturnType<typeof createOutboxRelay>;
  readonly claim: RecordingClaim;
  readonly events: string[];
  readonly dispatched: ClaimedOutboxRow[];
  readonly audits: Record<string, unknown>[];
}

function harness(
  rows: ClaimedOutboxRow[],
  over: Partial<OutboxRelayDeps> & {
    failDispatch?: (row: ClaimedOutboxRow) => Error | undefined;
  } = {},
): Harness {
  const claim = makeClaim(rows);
  mocks.withOutboxClaim.mockImplementation(
    (_db: unknown, _limit: number, fn: (c: unknown) => unknown) => fn(claim),
  );
  const { events, metrics } = metricsDouble();
  const dispatched: ClaimedOutboxRow[] = [];
  const audits: Record<string, unknown>[] = [];
  const dispatcher = (row: ClaimedOutboxRow): Promise<void> => {
    const failure = over.failDispatch?.(row);
    if (failure !== undefined) return Promise.reject(failure);
    dispatched.push(row);
    return Promise.resolve();
  };
  const relay = createOutboxRelay({
    config: { batchSize: 100, pollIntervalMs: 5, maxAttempts: 3 },
    relayDb,
    appDb,
    dispatchers: {
      'audit.event': dispatcher,
      'notify.send': dispatcher,
      'temporal.signal': dispatcher,
    },
    isTenantActive: () => Promise.resolve(true),
    audit: {
      emitAuditInTx: (_tx, input) => {
        audits.push(input as unknown as Record<string, unknown>);
        return Promise.resolve(undefined);
      },
    },
    metrics,
    logger: silent,
    random: () => 1,
    ...over,
  });
  return { relay, claim, events, dispatched, audits };
}

beforeEach(() => {
  mocks.withOutboxClaim.mockReset();
  mocks.outboxBacklog.mockReset();
  mocks.withTenant.mockReset();
  mocks.withTenant.mockImplementation(
    (_db: unknown, _tenant: string, fn: (t: unknown) => unknown) => fn({}),
  );
});

describe('pollOnce', () => {
  it('claims on the relay database with the configured batch size', async () => {
    const h = harness([]);
    await h.relay.pollOnce();
    expect(mocks.withOutboxClaim).toHaveBeenCalledWith(relayDb, 100, expect.any(Function));
  });

  it('dispatches each row to the dispatcher of its type and marks it dispatched', async () => {
    const seen: string[] = [];
    const rows = (['audit.event', 'notify.send', 'temporal.signal'] as const).map((type) =>
      makeRow({ type }),
    );
    const make = (name: string) => (row: ClaimedOutboxRow) => {
      seen.push(`${name}:${row.id}`);
      return Promise.resolve();
    };
    const h = harness(rows, {
      dispatchers: {
        'audit.event': make('audit'),
        'notify.send': make('notify'),
        'temporal.signal': make('signal'),
      },
    });
    expect(await h.relay.pollOnce()).toBe(3);
    expect(seen).toEqual([
      `audit:${rows[0]?.id}`,
      `notify:${rows[1]?.id}`,
      `signal:${rows[2]?.id}`,
    ]);
    expect(h.claim.calls).toEqual(rows.map((r) => ({ op: 'dispatched', id: r.id })));
    expect(h.events).toEqual([
      'dispatched:audit.event',
      'latency:ok',
      'dispatched:notify.send',
      'latency:ok',
      'dispatched:temporal.signal',
      'latency:ok',
    ]);
  });

  it('retries a transient failure with backoff on the next attempt count, not failing yet', async () => {
    const row = makeRow({ attempts: 1 });
    const h = harness([row], { failDispatch: () => new Error('valkey down') });
    await h.relay.pollOnce();
    expect(h.claim.calls).toEqual([
      { op: 'retry', id: row.id, error: 'Error: valkey down', delayMs: 2_000 },
    ]);
    expect(h.events).toEqual(['retried:notify.send']);
    expect(h.audits).toHaveLength(0);
  });

  it('keeps going after one row fails: the others are still delivered', async () => {
    const bad = makeRow();
    const good = makeRow({ aggregateId: null });
    const h = harness([bad, good], {
      failDispatch: (row) => (row.id === bad.id ? new Error('x') : undefined),
    });
    await h.relay.pollOnce();
    expect(h.claim.calls.map((c) => `${c.op}:${c.id}`)).toEqual([
      `retry:${bad.id}`,
      `dispatched:${good.id}`,
    ]);
  });

  it('fails the row permanently after max attempts: audited, counted, alerted', async () => {
    const row = makeRow({ attempts: 2, aggregateId: AGG });
    const h = harness([row], { failDispatch: () => new Error('still down') });
    await h.relay.pollOnce();
    expect(h.claim.calls).toEqual([{ op: 'failed', id: row.id, error: 'Error: still down' }]);
    expect(h.events).toEqual(['failed:notify.send']);
    expect(h.audits).toEqual([
      expect.objectContaining({
        tenantId: TENANT,
        action: 'outbox.delivery_failed',
        outcome: 'failure',
        reason: 'max_attempts_exhausted',
        dedupeKey: `outbox-failed:${row.id}`,
        actor: { type: 'system', id: 'outbox-relay' },
        target: { type: 'tenant', id: TENANT },
        metadata: { outboxId: row.id, messageType: 'notify.send', aggregateId: AGG, attempts: 3 },
      }),
    ]);
    expect(mocks.withTenant).toHaveBeenCalledWith(appDb, TENANT, expect.any(Function));
  });

  it('never stores an unredacted secret from an error message in last_error', async () => {
    const row = makeRow({ attempts: 0 });
    const h = harness([row], {
      failDispatch: () =>
        new Error('401 from https://user:hunter2@host/x Bearer abcdefghijklmnop1234567890'),
    });
    await h.relay.pollOnce();
    const error = h.claim.calls[0]?.error ?? '';
    expect(error).not.toContain('hunter2');
    expect(error).not.toContain('abcdefghijklmnop1234567890');
  });

  it('bounds last_error', async () => {
    const h = harness([makeRow()], { failDispatch: () => new Error('x'.repeat(5_000)) });
    await h.relay.pollOnce();
    expect((h.claim.calls[0]?.error ?? '').length).toBeLessThanOrEqual(500);
  });

  it('skips a row of an inactive tenant: failed with reason tenant_inactive, never dispatched', async () => {
    const row = makeRow();
    const h = harness([row], { isTenantActive: () => Promise.resolve(false) });
    await h.relay.pollOnce();
    expect(h.dispatched).toHaveLength(0);
    expect(h.claim.calls).toEqual([{ op: 'failed', id: row.id, error: TENANT_INACTIVE }]);
    expect(h.audits[0]).toMatchObject({
      reason: TENANT_INACTIVE,
      action: 'outbox.delivery_failed',
    });
    expect(h.events).toEqual(['failed:notify.send']);
  });

  it('treats a failing tenant lookup as a retryable error, not as inactive', async () => {
    const row = makeRow();
    const h = harness([row], { isTenantActive: () => Promise.reject(new Error('db blip')) });
    await h.relay.pollOnce();
    expect(h.dispatched).toHaveLength(0);
    expect(h.claim.calls[0]?.op).toBe('retry');
  });

  it('never fails a row whose failure cannot be audited: it retries instead', async () => {
    const row = makeRow({ attempts: 2 });
    const h = harness([row], {
      failDispatch: () => new Error('down'),
      audit: { emitAuditInTx: () => Promise.reject(new Error('audit unavailable')) },
    });
    await h.relay.pollOnce();
    expect(h.claim.calls.map((c) => c.op)).toEqual(['retry']);
    expect(h.events).toEqual([]);
  });

  it('lets a settle (database) error roll the whole claim back', async () => {
    const h = harness([makeRow()]);
    h.claim.markDispatched = () => Promise.reject(new Error('connection lost'));
    await expect(h.relay.pollOnce()).rejects.toThrow('connection lost');
  });
});

const AGG = '0190a000-0000-7000-8000-0000000000a1';

describe('start / stop', () => {
  it('polls repeatedly, survives a failing poll, and stops cleanly', async () => {
    const h = harness([]);
    let calls = 0;
    mocks.withOutboxClaim.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('db down')) : Promise.resolve(0);
    });
    mocks.outboxBacklog.mockResolvedValue({ 'notify.send': 4 });
    h.relay.start();
    h.relay.start();
    await vi.waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(3);
    });
    await h.relay.stop();
    const after = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(after);
    expect(h.events).toContain('backlog:notify.send=4');
    expect(h.events).toContain('backlog:audit.event=0');
  });

  it('polls again immediately while batches come back full', async () => {
    const h = harness([]);
    const sizes = [100, 100, 0];
    mocks.withOutboxClaim.mockImplementation(() => Promise.resolve(sizes.shift() ?? 0));
    mocks.outboxBacklog.mockResolvedValue({});
    const started = Date.now();
    h.relay.start();
    await vi.waitFor(() => {
      expect(sizes).toHaveLength(0);
    });
    await h.relay.stop();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
