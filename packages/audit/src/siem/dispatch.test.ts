import { describe, expect, it, vi } from 'vitest';

import { assertNoSecretsInConfig, type SiemConnector } from './connector.js';
import {
  createAuditExporter,
  CursorRaceError,
  type AuditExportDeps,
  type AuditExportOutcome,
} from './dispatch.js';
import {
  AuditExportSecretGoneError,
  type AuditExportAudit,
  type AuditExportSecretResolver,
  type AuditExportSubscription,
} from './ports.js';
import {
  FakeConnector,
  MemoryEvents,
  MemoryExportStore,
  MemoryMetrics,
  OTHER_TENANT,
  SECRET_REF,
  SECRET_VALUE,
  TENANT,
  makeEvent,
} from './test-support.js';

interface Harness {
  readonly ledger: MemoryEvents;
  readonly store: MemoryExportStore;
  readonly connector: FakeConnector;
  readonly metrics: MemoryMetrics;
  readonly audits: Parameters<AuditExportAudit>[0][];
  readonly resolveSecret: ReturnType<typeof vi.fn<AuditExportSecretResolver>>;
  run(sub?: AuditExportSubscription): Promise<AuditExportOutcome>;
}

function setup(options: {
  events?: number;
  actions?: Parameters<MemoryEvents['append']>[1];
  batchSize?: number;
  connector?: SiemConnector;
  subscription?: Partial<AuditExportSubscription>;
  resolveSecret?: AuditExportSecretResolver;
}): Harness {
  const ledger = new MemoryEvents().append(options.events ?? 5, options.actions);
  const store = new MemoryExportStore(ledger);
  const connector = new FakeConnector(500);
  const metrics = new MemoryMetrics();
  const audits: Parameters<AuditExportAudit>[0][] = [];
  const resolveSecret = vi.fn<AuditExportSecretResolver>(
    options.resolveSecret ??
      ((tenantId: string, ref: string) => {
        expect(tenantId).toBe(TENANT);
        expect(ref).toBe(SECRET_REF);
        return Promise.resolve(SECRET_VALUE);
      }),
  );
  const connectors = new Map<string, SiemConnector>([
    ['splunk_hec', options.connector ?? connector],
  ]);
  const deps: AuditExportDeps = {
    store,
    connectors,
    resolveSecret,
    audit: (input) => {
      audits.push(input);
      return Promise.resolve();
    },
    metrics,
    batchSize: options.batchSize ?? 500,
  };
  const exporter = createAuditExporter(deps);
  const sub = store.put(options.subscription ?? {});
  return {
    ledger,
    store,
    connector,
    metrics,
    audits,
    resolveSecret,
    // Each call reads the subscription fresh, as the activity does (the cursor moves between calls).
    run: (override) => exporter(override ?? store.get(sub.id)),
  };
}

describe('SIEM export dispatcher: delivery and cursor', () => {
  it('delivers new events in seq order and advances the cursor to the last one', async () => {
    const h = setup({ events: 5 });
    const outcome = await h.run();
    expect(outcome).toEqual({ status: 'delivered', cursorSeq: 5, delivered: 5 });
    expect(h.connector.delivered.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(h.store.get().cursorSeq).toBe(5);
    expect(h.metrics.deliveredBatches).toEqual([{ kind: 'splunk_hec', count: 5 }]);
  });

  it('chunks a window to the connector batch limit, in order', async () => {
    const h = setup({ events: 5, batchSize: 5 });
    const small = new FakeConnector(2);
    const exporter = createAuditExporter({
      store: h.store,
      connectors: new Map([['splunk_hec', small]]),
      resolveSecret: () => Promise.resolve(SECRET_VALUE),
      audit: () => Promise.resolve(),
      metrics: h.metrics,
      batchSize: 5,
    });
    const outcome = await exporter(h.store.get());
    expect(outcome.status).toBe('delivered');
    expect(small.calls.map((c) => c.seqs)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('a failed delivery leaves the cursor unchanged and is audited, then the retry resumes with no gap', async () => {
    const h = setup({ events: 3 });
    h.connector.failNext = 1;
    const failed = await h.run();
    expect(failed).toMatchObject({ status: 'failed', cursorSeq: 0, delivered: 0 });
    expect(h.store.get().cursorSeq).toBe(0);
    expect(h.connector.delivered).toHaveLength(0);
    expect(h.metrics.failures).toEqual(['splunk_hec']);
    expect(h.audits).toEqual([
      expect.objectContaining({ action: 'export.generated', outcome: 'failure', reason: 'Error' }),
    ]);

    const retried = await h.run();
    expect(retried).toEqual({ status: 'delivered', cursorSeq: 3, delivered: 3 });
    expect(h.connector.delivered.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('a partial confirmation moves the cursor only as far as the destination confirmed, and resumes there', async () => {
    const h = setup({ events: 5 });
    h.connector.confirmUpTo = 3;
    expect(await h.run()).toEqual({ status: 'partial', cursorSeq: 3, delivered: 3 });
    expect(h.metrics.backlogs.at(-1)).toBe(2);
    h.connector.confirmUpTo = undefined;
    expect(await h.run()).toEqual({ status: 'delivered', cursorSeq: 5, delivered: 2 });
    expect(h.connector.delivered.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses a confirmed position outside the window and moves nothing', async () => {
    for (const position of [-1, Number.NaN, 99]) {
      const h = setup({ events: 3 });
      h.connector.forcedPosition = position;
      expect(await h.run()).toMatchObject({
        status: 'failed',
        cursorSeq: 0,
        reason: 'invalid_delivery_position',
      });
      expect(h.store.get().cursorSeq).toBe(0);
    }
  });

  it('an idle subscription reads nothing new and never resolves its secret', async () => {
    const h = setup({ events: 0 });
    expect(await h.run()).toEqual({ status: 'idle', cursorSeq: 0, delivered: 0 });
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.connector.calls).toHaveLength(0);
  });

  it('resumes after the cursor with no gap or re-send of confirmed events', async () => {
    const h = setup({ events: 4, subscription: { cursorSeq: 2 } });
    expect(await h.run()).toEqual({ status: 'delivered', cursorSeq: 4, delivered: 2 });
    expect(h.connector.delivered.map((e) => e.seq)).toEqual([3, 4]);
  });

  it('stops at the cursor while paused, reading and sending nothing', async () => {
    const h = setup({ events: 3, subscription: { status: 'paused', cursorSeq: 1 } });
    expect(await h.run()).toEqual({
      status: 'skipped',
      reason: 'paused',
      cursorSeq: 1,
      delivered: 0,
    });
    expect(h.connector.calls).toHaveLength(0);
    expect(h.resolveSecret).not.toHaveBeenCalled();
    expect(h.store.get().cursorSeq).toBe(1);
  });

  it('never sends another tenant events: the ledger filter is by tenant', async () => {
    const h = setup({ events: 0 });
    h.ledger.events.push(makeEvent(1, 'gate2.decided', OTHER_TENANT));
    h.ledger.events.push(makeEvent(2, 'gate2.decided', TENANT));
    expect(await h.run()).toMatchObject({ status: 'delivered', delivered: 1 });
    expect(h.connector.delivered.every((e) => e.tenantId === TENANT)).toBe(true);
  });

  it('reports cursor and backlog after a window', async () => {
    const h = setup({ events: 4 });
    await h.run();
    expect(h.metrics.cursors.at(-1)).toBe(4);
    expect(h.metrics.backlogs.at(-1)).toBe(0);
  });

  it('a lost compare-and-set on the cursor stops the run instead of racing a second runner', async () => {
    const h = setup({ events: 2 });
    vi.spyOn(h.store, 'advanceCursor').mockResolvedValueOnce(false);
    await expect(h.run()).rejects.toBeInstanceOf(CursorRaceError);
  });

  it('rejects a non-positive batch size at construction', () => {
    const h = setup({ events: 0 });
    expect(() =>
      createAuditExporter({
        store: h.store,
        connectors: new Map(),
        resolveSecret: () => Promise.resolve(''),
        audit: () => Promise.resolve(),
        metrics: h.metrics,
        batchSize: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('SIEM export dispatcher: filters', () => {
  it('an allowlist exports only the named actions and still moves the cursor past the rest', async () => {
    const h = setup({
      events: 4,
      actions: ['gate2.decided', 'kill.triggered'],
      subscription: { filters: { actions: ['kill.triggered'] } },
    });
    expect(await h.run()).toEqual({ status: 'delivered', cursorSeq: 4, delivered: 2 });
    expect(h.connector.delivered.map((e) => e.action)).toEqual([
      'kill.triggered',
      'kill.triggered',
    ]);
    expect(h.connector.delivered.map((e) => e.action)).not.toContain('gate2.decided');
  });

  it('a denylist drops named actions', async () => {
    const h = setup({
      events: 4,
      actions: ['gate2.decided', 'kill.triggered'],
      subscription: { filters: { excludeActions: ['gate2.decided'] } },
    });
    expect(await h.run()).toMatchObject({ status: 'delivered', cursorSeq: 4, delivered: 2 });
    expect(h.connector.delivered.map((e) => e.action)).not.toContain('gate2.decided');
  });

  it('a window that is entirely filtered out sends nothing and still advances', async () => {
    const h = setup({ events: 3, subscription: { filters: { actions: ['kill.triggered'] } } });
    expect(await h.run()).toEqual({ status: 'delivered', cursorSeq: 3, delivered: 0 });
    expect(h.connector.calls).toHaveLength(0);
    expect(h.store.get().cursorSeq).toBe(3);
  });

  it('malformed filters disable the subscription instead of exporting everything', async () => {
    const h = setup({ events: 2, subscription: { filters: { actions: ['not.a.real.action'] } } });
    expect(await h.run()).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(h.store.get().status).toBe('error');
    expect(h.connector.calls).toHaveLength(0);
  });
});

describe('SIEM export dispatcher: failure modes', () => {
  it('an unsupported kind is disabled and audited', async () => {
    const h = setup({ events: 2 });
    const exporter = createAuditExporter({
      store: h.store,
      connectors: new Map(),
      resolveSecret: () => Promise.resolve(SECRET_VALUE),
      audit: (input) => {
        h.audits.push(input);
        return Promise.resolve();
      },
      metrics: h.metrics,
      batchSize: 10,
    });
    expect(await exporter(h.store.get())).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(h.store.get().status).toBe('error');
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: 'connector.configured',
        outcome: 'failure',
        reason: 'unsupported_kind',
      }),
    ]);
  });

  it('a config the connector refuses disables the subscription', async () => {
    const h = setup({ events: 2, subscription: { config: { wrong: true } } });
    expect(await h.run()).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(h.store.get().status).toBe('error');
    expect(h.connector.calls).toHaveLength(0);
  });

  it('a config that smuggles a credential is refused and the value never reaches the audit trail', async () => {
    const strict: SiemConnector = {
      kind: 'splunk_hec',
      maxBatchSize: 10,
      validate(config) {
        assertNoSecretsInConfig(config);
        return config;
      },
      testConnection: () => Promise.resolve(),
      deliver: () => Promise.resolve({ deliveredThrough: 0 }),
    };
    const h = setup({
      events: 1,
      connector: strict,
      subscription: { config: { host: 'siem.example.test', hecToken: SECRET_VALUE } },
    });
    expect(await h.run()).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(h.store.get().status).toBe('error');
    expect(JSON.stringify(h.audits)).not.toContain(SECRET_VALUE);
  });

  it('a credential that is gone disables the subscription without delivering', async () => {
    const h = setup({
      events: 2,
      resolveSecret: () => Promise.reject(new AuditExportSecretGoneError('shredded')),
    });
    expect(await h.run()).toMatchObject({ status: 'skipped', reason: 'disabled' });
    expect(h.store.get().status).toBe('error');
    expect(h.connector.calls).toHaveLength(0);
    expect(h.audits).toEqual([
      expect.objectContaining({ reason: 'secret_unavailable', outcome: 'failure' }),
    ]);
  });

  it('a transient credential error is rethrown (retried), and the subscription stays active', async () => {
    const h = setup({
      events: 2,
      resolveSecret: () => Promise.reject(new Error('secrets service timed out')),
    });
    await expect(h.run()).rejects.toThrow('secrets service timed out');
    expect(h.store.get().status).toBe('active');
    expect(h.store.get().cursorSeq).toBe(0);
  });

  it('the credential is fetched by reference and never written to the stored config', async () => {
    const h = setup({ events: 2 });
    await h.run();
    expect(h.resolveSecret).toHaveBeenCalledTimes(1);
    expect(h.connector.calls.every((c) => c.secret === SECRET_VALUE)).toBe(true);
    expect(JSON.stringify(h.store.get())).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(h.audits)).not.toContain(SECRET_VALUE);
  });

  it('the subscription row is an ordinary value: the dispatcher does not mutate its input', async () => {
    const h = setup({ events: 1 });
    const sub = h.store.get();
    const before = structuredClone(sub);
    await h.run(sub);
    expect(sub).toEqual(before);
  });
});

/** The value a call throws, or `undefined` when it returns normally. */
function thrownBy(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('assertNoSecretsInConfig', () => {
  it('accepts non-secret settings, including token-like ids and nested objects', () => {
    expect(() => {
      assertNoSecretsInConfig({
        host: 'siem.example.test',
        port: 6514,
        tokenId: 'tok_1',
        index: 'main',
      });
    }).not.toThrow();
  });

  it('refuses any secret-looking key at any depth and names the key, never the value', () => {
    expect(() => {
      assertNoSecretsInConfig({ host: 'h', token: SECRET_VALUE });
    }).toThrow(/token/);
    expect(() => {
      assertNoSecretsInConfig({ http: { password: SECRET_VALUE } });
    }).toThrow(/http\.password/);
    expect(() => {
      assertNoSecretsInConfig({ list: [{ apiKey: SECRET_VALUE }] });
    }).toThrow(/list\[0\]\.apiKey/);
    const error = thrownBy(() => {
      assertNoSecretsInConfig({ clientSecret: SECRET_VALUE });
    });
    expect(String(error)).not.toContain(SECRET_VALUE);
  });
});
