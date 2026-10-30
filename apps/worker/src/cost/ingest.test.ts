import { describe, expect, it } from 'vitest';

import { ValidationError } from '@blackwing/errors';

import { ingestUsageEvent, type CostIngestDeps } from './ingest.js';

import type {
  CostIngestMetrics,
  CostIngestStore,
  CostLedgerInsert,
  CostPriceRow,
  CostRunRef,
} from './ports.js';
import type { Logger } from '@blackwing/logger';

const TENANT_A = '0190a000-0000-7000-8000-00000000000a';
const TENANT_B = '0190a000-0000-7000-8000-00000000000b';
const RUN_A = '0190a000-0000-7000-8000-0000000000a1';
const PRICE_ID = '0190a000-0000-7000-8000-000000000e01';
const SESSION = '0190a000-0000-7000-8000-0000000005e1';

const PRICE: CostPriceRow = {
  id: PRICE_ID,
  inputPerMtok: '3.000000',
  outputPerMtok: '15.000000',
  cacheWritePerMtok: '3.750000',
  cacheReadPerMtok: '0.300000',
};

/** An in-memory store keyed by tenant, so cross-tenant reads and writes are visible to the tests. */
class FakeStore implements CostIngestStore {
  readonly runs = new Map<string, CostRunRef>();
  readonly prices = new Map<string, CostPriceRow>();
  readonly rows: { tenantId: string; row: CostLedgerInsert }[] = [];

  findRun(tenantId: string, runId: string) {
    return Promise.resolve(this.runs.get(`${tenantId}/${runId}`));
  }

  findPrice(_tenantId: string, key: { provider: string; model: string; version: number }) {
    return Promise.resolve(this.prices.get(`${key.provider}/${key.model}@${key.version}`));
  }

  insertLedgerRow(tenantId: string, row: CostLedgerInsert) {
    const duplicate = this.rows.some(
      (r) => r.tenantId === tenantId && r.row.usageEventId === row.usageEventId,
    );
    if (!duplicate) this.rows.push({ tenantId, row });
    return Promise.resolve(!duplicate);
  }
}

function harness(store = new FakeStore()) {
  const events: string[] = [];
  const unpriced: string[] = [];
  const lags: number[] = [];
  const metrics: CostIngestMetrics = {
    event: (outcome) => events.push(outcome),
    unpriced: (reason) => unpriced.push(reason),
    lagMs: (ms) => lags.push(ms),
  };
  const alerts: Record<string, unknown>[] = [];
  const logger = {
    error: (fields: Record<string, unknown>) => alerts.push(fields),
  } as unknown as Logger;
  const deps: CostIngestDeps = {
    store,
    metrics,
    logger,
    now: () => Date.parse('2026-10-20T10:00:05.000Z'),
  };
  return { store, deps, events, unpriced, lags, alerts };
}

function seed(
  store: FakeStore,
  overrides: { state?: CostRunRef['state']; pin?: number | null } = {},
) {
  store.runs.set(`${TENANT_A}/${RUN_A}`, {
    state: overrides.state ?? 'executing',
    priceTableVersion: overrides.pin === undefined ? 3 : overrides.pin,
  });
  store.prices.set('anthropic/claude-sonnet-5-5@3', PRICE);
}

const event = (overrides: Record<string, unknown> = {}) => ({
  usageEventId: 'evt-1',
  tenantId: TENANT_A,
  runId: RUN_A,
  sessionId: SESSION,
  persona: 'recon-scout',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  occurredAt: '2026-10-20T10:00:00.000Z',
  ...overrides,
});

describe('ingestUsageEvent: attribution and pricing', () => {
  it('writes exactly one priced row with run, stage, persona and session attribution', async () => {
    const { store, deps, events, lags } = harness();
    seed(store);
    const outcome = await ingestUsageEvent(deps, event());
    expect(outcome).toEqual({ status: 'recorded', unpriced: null });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      tenantId: TENANT_A,
      row: {
        runId: RUN_A,
        agentSessionId: SESSION,
        stage: 'execution',
        persona: 'recon-scout',
        priceTableId: PRICE_ID,
        needsPricing: false,
        costUsd: '3.0000000000',
        usageEventId: 'evt-1',
      },
    });
    expect(events).toEqual(['recorded']);
    expect(lags).toEqual([5_000]);
  });

  it('derives the stage from the run phase', async () => {
    const { store, deps } = harness();
    seed(store, { state: 'validating' });
    await ingestUsageEvent(deps, event());
    expect(store.rows[0]?.row.stage).toBe('validation');
  });

  it('prices against the run pinned version, not the newest one', async () => {
    const { store, deps } = harness();
    seed(store, { pin: 3 });
    store.prices.set('anthropic/claude-sonnet-5-5@4', {
      ...PRICE,
      id: '0190a000-0000-7000-8000-000000000e04',
      inputPerMtok: '99.000000',
    });
    await ingestUsageEvent(deps, event());
    expect(store.rows[0]?.row.costUsd).toBe('3.0000000000');
    expect(store.rows[0]?.row.priceTableId).toBe(PRICE_ID);
  });

  it('attributes an event without a run to stage other and records it', async () => {
    const { store, deps, unpriced } = harness();
    seed(store);
    const outcome = await ingestUsageEvent(deps, event({ runId: null, sessionId: null }));
    expect(outcome.status).toBe('recorded');
    expect(store.rows[0]?.row).toMatchObject({ runId: null, stage: 'other', needsPricing: true });
    expect(unpriced).toEqual(['run_unpinned']);
  });

  it('treats a run the tenant cannot see as absent: recorded under the tenant, never the other run', async () => {
    const { store, deps } = harness();
    seed(store);
    const other = event({ tenantId: TENANT_B });
    await ingestUsageEvent(deps, other);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      tenantId: TENANT_B,
      row: { runId: null, stage: 'other', needsPricing: true },
    });
  });
});

describe('ingestUsageEvent: unpriceable usage', () => {
  it('records an unknown model at zero cost, flagged, with an operator alert and a metric', async () => {
    const { store, deps, unpriced, alerts, events } = harness();
    seed(store);
    const outcome = await ingestUsageEvent(deps, event({ model: 'claude-haiku-5-5' }));
    expect(outcome).toEqual({ status: 'recorded', unpriced: 'unknown_model' });
    expect(store.rows[0]?.row).toMatchObject({
      priceTableId: null,
      needsPricing: true,
      costUsd: '0',
      inputTokens: 1_000_000,
    });
    expect(unpriced).toEqual(['unknown_model']);
    expect(events).toEqual(['unpriced']);
    expect(alerts).toEqual([
      expect.objectContaining({ alert: 'cost_ingest_unpriced', reason: 'unknown_model' }),
    ]);
  });

  it('records a run with no price pin at zero cost, never dropping the usage', async () => {
    const { store, deps, alerts } = harness();
    seed(store, { pin: null });
    const outcome = await ingestUsageEvent(deps, event());
    expect(outcome.unpriced).toBe('run_unpinned');
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.row.costUsd).toBe('0');
    expect(alerts).toHaveLength(1);
  });
});

describe('ingestUsageEvent: idempotency', () => {
  it('a replayed event is a no-op: no second row, no second alert', async () => {
    const { store, deps, events, alerts } = harness();
    seed(store);
    await ingestUsageEvent(deps, event());
    const replay = await ingestUsageEvent(deps, event());
    expect(replay).toEqual({ status: 'duplicate', unpriced: null });
    expect(store.rows).toHaveLength(1);
    expect(events).toEqual(['recorded', 'duplicate']);
    expect(alerts).toHaveLength(0);
  });

  it('a replayed unpriceable event does not alert twice', async () => {
    const { store, deps, alerts } = harness();
    seed(store);
    await ingestUsageEvent(deps, event({ model: 'claude-haiku-5-5' }));
    await ingestUsageEvent(deps, event({ model: 'claude-haiku-5-5' }));
    expect(store.rows).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('the same usage event id in another tenant is a separate row', async () => {
    const { store, deps } = harness();
    seed(store);
    await ingestUsageEvent(deps, event());
    await ingestUsageEvent(deps, event({ tenantId: TENANT_B }));
    expect(store.rows.map((r) => r.tenantId)).toEqual([TENANT_A, TENANT_B]);
  });
});

describe('ingestUsageEvent: content stripping and validation', () => {
  it('strips content fields: nothing the gateway emitted beyond counts and metadata is persisted', async () => {
    const { store, deps } = harness();
    seed(store);
    await ingestUsageEvent(
      deps,
      event({ prompt: 'exfiltrated prompt text', completion: 'model output', messages: [] }),
    );
    const persisted = JSON.stringify(store.rows[0]?.row);
    expect(persisted).not.toContain('exfiltrated');
    expect(persisted).not.toContain('model output');
    expect(store.rows[0]?.row).not.toHaveProperty('prompt');
  });

  it('refuses a malformed event with a generic message and writes nothing', async () => {
    const { store, deps } = harness();
    seed(store);
    await expect(ingestUsageEvent(deps, event({ inputTokens: -5 }))).rejects.toThrow(
      ValidationError,
    );
    await expect(ingestUsageEvent(deps, event({ tenantId: 'not-a-uuid' }))).rejects.toThrow(
      'usage event is malformed',
    );
    expect(store.rows).toHaveLength(0);
  });

  it('refuses an event with no tenant (fail closed)', async () => {
    const { store, deps } = harness();
    seed(store);
    const withoutTenant: Record<string, unknown> = { ...event() };
    delete withoutTenant.tenantId;
    await expect(ingestUsageEvent(deps, withoutTenant)).rejects.toBeInstanceOf(ValidationError);
    expect(store.rows).toHaveLength(0);
  });
});

describe('ingestUsageEvent: out-of-order delivery', () => {
  it('each row stands alone: a later event never reorders or alters an earlier row', async () => {
    const { store, deps } = harness();
    seed(store);
    await ingestUsageEvent(
      deps,
      event({ usageEventId: 'late', occurredAt: '2026-10-20T10:05:00.000Z' }),
    );
    await ingestUsageEvent(
      deps,
      event({ usageEventId: 'early', occurredAt: '2026-10-20T09:00:00.000Z' }),
    );
    expect(store.rows.map((r) => r.row.usageEventId)).toEqual(['late', 'early']);
    expect(store.rows.map((r) => r.row.costUsd)).toEqual(['3.0000000000', '3.0000000000']);
  });
});
