// Usage ingestion (COST-002) against Postgres 16 and Valkey 8 (Testcontainers): one row per event with the
// right attribution, replay is a no-op, pinned pricing, unpriceable usage is recorded and alerted, tenant B
// never writes to tenant A, and the BullMQ consumer ingests a job end to end.

import { Queue } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, type Database, migrateDatabase } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import {
  type PostgresHandle,
  type ValkeyHandle,
  withPostgres,
  withValkey,
} from '@blackwing/testing/containers';

import { ingestUsageEvent, type CostIngestDeps } from './ingest.js';
import { COST_USAGE_QUEUE, startCostUsageWorker } from './queue.js';
import { createPgCostIngestStore } from './store-pg.js';

import type { Logger } from '@blackwing/logger';

let postgres: PostgresHandle;
let valkey: ValkeyHandle;
let db: Database;

const tenantA = newId();
const tenantB = newId();
const runA = newId();
const runAPinnedNewer = newId();
const runAUnpinned = newId();
const runB = newId();
const SHA = 'c'.repeat(64);
let priceV3 = '';
let priceV4 = '';

const alerts: Record<string, unknown>[] = [];
const logger = {
  error: (fields: Record<string, unknown>) => {
    alerts.push(fields);
  },
} as unknown as Logger;
const ingestDeps = (): CostIngestDeps => ({
  store: createPgCostIngestStore(db),
  metrics: { event: () => undefined, unpriced: () => undefined, lagMs: () => undefined },
  logger,
});

/** Inserts a `price_tables` row as the operator role (the only writer of platform prices). */
async function insertPrice(version: number, inputPerMtok: string): Promise<string> {
  const id = newId();
  const client = await postgres.ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE bw_operator');
    await client.query(
      `INSERT INTO price_tables (id, provider, model, version, input_per_mtok, output_per_mtok,
          cache_write_per_mtok, cache_read_per_mtok, effective_from, sha256)
       VALUES ($1, 'anthropic', 'claude-sonnet-5-5', $2, $3, 15, 3.75, 0.3, now(), $4)`,
      [id, version, inputPerMtok, SHA],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return id;
}

async function insertRun(tenantId: string, runId: string, state: string, pin: number | null) {
  await postgres.withTenant(tenantId, (tx) =>
    tx.query(
      'INSERT INTO runs (id, tenant_id, state, price_table_version) VALUES ($1, $2, $3, $4)',
      [runId, tenantId, state, pin],
    ),
  );
}

interface LedgerRow {
  usage_event_id: string;
  run_id: string | null;
  stage: string;
  persona: string | null;
  agent_session_id: string | null;
  price_table_id: string | null;
  needs_pricing: boolean;
  cost_usd: string;
  input_tokens: string;
}

/** The tenant's own ledger, read through its transaction (RLS applies). */
async function ledgerOf(tenantId: string): Promise<LedgerRow[]> {
  return postgres.withTenant(tenantId, async (tx) => {
    const result = await tx.query<LedgerRow>(
      `SELECT usage_event_id, run_id, stage, persona, agent_session_id, price_table_id,
              needs_pricing, cost_usd::text, input_tokens::text
         FROM cost_ledger ORDER BY usage_event_id`,
    );
    return result.rows;
  });
}

const event = (overrides: Record<string, unknown> = {}) => ({
  usageEventId: 'gw-evt-1',
  tenantId: tenantA,
  runId: runA,
  sessionId: null,
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

beforeAll(async () => {
  [postgres, valkey] = await Promise.all([
    withPostgres({ migrations: (owner) => migrateDatabase(owner) }),
    withValkey(),
  ]);
  db = createDatabase(postgres.appPool);
  priceV3 = await insertPrice(3, '3.000000');
  priceV4 = await insertPrice(4, '99.000000');
  await insertRun(tenantA, runA, 'executing', 3);
  await insertRun(tenantA, runAPinnedNewer, 'validating', 4);
  await insertRun(tenantA, runAUnpinned, 'planning', null);
  await insertRun(tenantB, runB, 'executing', 3);
}, 240_000);

afterAll(async () => {
  await Promise.all([postgres.stop(), valkey.stop()]);
});

beforeEach(() => {
  alerts.length = 0;
});

describe('usage ingestion against Postgres (COST-002)', () => {
  it('writes exactly one ledger row with run, stage, persona and the pinned price table', async () => {
    const outcome = await ingestUsageEvent(ingestDeps(), event({ usageEventId: 'one' }));
    expect(outcome).toEqual({ status: 'recorded', unpriced: null });
    const rows = (await ledgerOf(tenantA)).filter((r) => r.usage_event_id === 'one');
    expect(rows).toEqual([
      {
        usage_event_id: 'one',
        run_id: runA,
        stage: 'execution',
        persona: 'recon-scout',
        agent_session_id: null,
        price_table_id: priceV3,
        needs_pricing: false,
        cost_usd: '3.0000000000',
        input_tokens: '1000000',
      },
    ]);
  });

  it('a replayed event does not duplicate the row', async () => {
    const replay = await ingestUsageEvent(ingestDeps(), event({ usageEventId: 'one' }));
    expect(replay.status).toBe('duplicate');
    expect((await ledgerOf(tenantA)).filter((r) => r.usage_event_id === 'one')).toHaveLength(1);
  });

  it('prices each row against its own run pin, not the newest table', async () => {
    await ingestUsageEvent(
      ingestDeps(),
      event({ usageEventId: 'pinned-v4', runId: runAPinnedNewer }),
    );
    const row = (await ledgerOf(tenantA)).find((r) => r.usage_event_id === 'pinned-v4');
    expect(row).toMatchObject({
      price_table_id: priceV4,
      cost_usd: '99.0000000000',
      stage: 'validation',
    });
  });

  it('records a model with no price at the pinned version as zero cost, flagged, with an alert', async () => {
    const outcome = await ingestUsageEvent(
      ingestDeps(),
      event({ usageEventId: 'unpriced', model: 'claude-haiku-5-5' }),
    );
    expect(outcome.unpriced).toBe('unknown_model');
    expect((await ledgerOf(tenantA)).find((r) => r.usage_event_id === 'unpriced')).toMatchObject({
      price_table_id: null,
      needs_pricing: true,
      cost_usd: '0.0000000000',
      input_tokens: '1000000',
    });
    expect(alerts).toEqual([expect.objectContaining({ alert: 'cost_ingest_unpriced' })]);
  });

  it('records a run with no pin as unpriced, never dropping the usage', async () => {
    await ingestUsageEvent(ingestDeps(), event({ usageEventId: 'unpinned', runId: runAUnpinned }));
    expect((await ledgerOf(tenantA)).find((r) => r.usage_event_id === 'unpinned')).toMatchObject({
      needs_pricing: true,
      cost_usd: '0.0000000000',
      run_id: runAUnpinned,
    });
  });

  it('attributes an event with no run to the tenant, stage other, and still records it', async () => {
    await ingestUsageEvent(
      ingestDeps(),
      event({ usageEventId: 'no-run', runId: null, persona: null }),
    );
    expect((await ledgerOf(tenantA)).find((r) => r.usage_event_id === 'no-run')).toMatchObject({
      run_id: null,
      stage: 'other',
      persona: null,
      needs_pricing: true,
    });
  });

  it('cross-tenant: tenant B usage never writes to tenant A, and tenant B cannot read A rows', async () => {
    const before = (await ledgerOf(tenantA)).length;
    // Tenant B names tenant A's run: the run is invisible to tenant B, so the row stays with tenant B.
    await ingestUsageEvent(
      ingestDeps(),
      event({ usageEventId: 'b-spoof', tenantId: tenantB, runId: runA }),
    );
    await ingestUsageEvent(
      ingestDeps(),
      event({ usageEventId: 'b-own', tenantId: tenantB, runId: runB }),
    );
    expect((await ledgerOf(tenantA)).length).toBe(before);
    expect((await ledgerOf(tenantA)).some((r) => r.usage_event_id === 'b-spoof')).toBe(false);
    const bRows = await ledgerOf(tenantB);
    expect(bRows.find((r) => r.usage_event_id === 'b-spoof')).toMatchObject({
      run_id: null,
      stage: 'other',
      needs_pricing: true,
    });
    expect(bRows.find((r) => r.usage_event_id === 'b-own')).toMatchObject({
      run_id: runB,
      stage: 'execution',
      price_table_id: priceV3,
    });
  });

  it('the same usage event id in two tenants is two rows, one per tenant', async () => {
    await ingestUsageEvent(
      ingestDeps(),
      event({ usageEventId: 'shared', tenantId: tenantB, runId: runB }),
    );
    await ingestUsageEvent(
      ingestDeps(),
      event({ usageEventId: 'shared', tenantId: tenantA, runId: runA }),
    );
    expect((await ledgerOf(tenantA)).filter((r) => r.usage_event_id === 'shared')).toHaveLength(1);
    expect((await ledgerOf(tenantB)).filter((r) => r.usage_event_id === 'shared')).toHaveLength(1);
  });

  it('strips content: no content field reaches the stored row', async () => {
    await ingestUsageEvent(
      ingestDeps(),
      event({ usageEventId: 'content', prompt: 'leaked prompt' }),
    );
    const stored = await postgres.withTenant(tenantA, async (tx) =>
      tx.query<{ row: string }>(
        "SELECT row_to_json(c)::text AS row FROM cost_ledger c WHERE usage_event_id = 'content'",
      ),
    );
    expect(stored.rows[0]?.row).not.toContain('leaked prompt');
  });

  it('the BullMQ consumer ingests a queued usage event end to end', async () => {
    const connection = { host: valkey.host, port: valkey.port, password: valkey.password };
    const queue = new Queue(COST_USAGE_QUEUE, { connection });
    const worker = startCostUsageWorker(connection, ingestDeps());
    try {
      await queue.add('usage', event({ usageEventId: 'queued', persona: 'exploit-dev' }));
      const deadline = Date.now() + 20_000;
      let found: LedgerRow | undefined;
      while (found === undefined && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        found = (await ledgerOf(tenantA)).find((r) => r.usage_event_id === 'queued');
      }
      expect(found).toMatchObject({ persona: 'exploit-dev', cost_usd: '3.0000000000' });
    } finally {
      await worker.close();
      await queue.close();
    }
  }, 60_000);
});
