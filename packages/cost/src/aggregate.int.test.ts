// Cost aggregates against Postgres 16 with the real migrations (COST-003, Testcontainers). Run with `pnpm test:int`.
// Proves: run totals equal the sum of their ledger rows, stage and persona breakdowns sum to the run total, month
// buckets follow the tenant timezone and `occurred_at` (a run spanning a month edge splits), an empty run is zero,
// negative rows are refused at write time so totals can never net below their true sum, and tenant B reads
// nothing of tenant A (RLS) and fails closed without a tenant.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database, migrateDatabase } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { type CostAggregates, createCostAggregates } from './aggregate.js';

import type pg from 'pg';

const SHA = 'd'.repeat(64);
const tenantA = newId();
const tenantB = newId();
const runA = newId();
const runEmpty = newId();
const runB = newId();

let pgHandle: PostgresHandle;
let database: Database;
let aggregates: CostAggregates;
let priceTableId = '';

/** Sums decimal strings exactly at the ledger's 10-place scale (the test's oracle; never a float). */
function sumDecimal(values: readonly string[]): string {
  const SCALE = 10;
  const total = values.reduce((acc, value) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return acc + BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(fraction.padEnd(SCALE, '0'));
  }, 0n);
  const digits = total.toString().padStart(SCALE + 1, '0');
  return `${digits.slice(0, -SCALE)}.${digits.slice(-SCALE)}`;
}

/** Runs `fn` as the platform operator (owner connection, SET ROLE bw_operator): the only writer of prices. */
async function asOperator(fn: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pgHandle.ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE bw_operator');
    await fn(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface LedgerRow {
  tenantId: string;
  runId: string | null;
  stage: string;
  persona: string | null;
  costUsd: string;
  inputTokens: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  occurredAt: string;
  needsPricing?: boolean;
}

async function insertLedgerRow(row: LedgerRow): Promise<void> {
  const needsPricing = row.needsPricing ?? false;
  await pgHandle.withTenant(row.tenantId, (client) =>
    client.query(
      `INSERT INTO cost_ledger (id, tenant_id, run_id, stage, persona, provider, model, price_table_id,
          needs_pricing, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_usd,
          usage_event_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'anthropic', 'claude-sonnet-5-5', $6, $7, $8, $9, 0, $10, $11, $12, $13)`,
      [
        newId(),
        row.tenantId,
        row.runId,
        row.stage,
        row.persona,
        needsPricing ? null : priceTableId,
        needsPricing,
        row.inputTokens,
        row.outputTokens ?? 0,
        row.cacheReadTokens ?? 0,
        row.costUsd,
        `evt_${newId()}`,
        row.occurredAt,
      ],
    ),
  );
}

beforeAll(async () => {
  pgHandle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  database = createDatabase(pgHandle.appPool);
  aggregates = createCostAggregates(database);

  await asOperator(async (client) => {
    const id = newId();
    priceTableId = id;
    await client.query(
      `INSERT INTO price_tables (id, provider, model, version, input_per_mtok, output_per_mtok,
          cache_write_per_mtok, cache_read_per_mtok, effective_from, sha256)
       VALUES ($1, 'anthropic', 'claude-sonnet-5-5', 1, 3, 15, 3.75, 0.3, now(), $2)`,
      [id, SHA],
    );
  });

  // Tenant A, run A: one row spans the UTC month edge (30 Sep 23:30Z, 1 Oct 00:30Z), plus a mid-October row and
  // an unpriced row. The unpriced row carries zero cost and no price table, as ingestion writes it.
  await insertLedgerRow({
    tenantId: tenantA,
    runId: runA,
    stage: 'execution',
    persona: 'recon-agent',
    costUsd: '0.1234567890',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 50,
    occurredAt: '2026-09-30T23:30:00Z',
  });
  await insertLedgerRow({
    tenantId: tenantA,
    runId: runA,
    stage: 'execution',
    persona: 'planner',
    costUsd: '0.0000000001',
    inputTokens: 10,
    occurredAt: '2026-10-01T00:30:00Z',
  });
  await insertLedgerRow({
    tenantId: tenantA,
    runId: runA,
    stage: 'recon',
    persona: null,
    costUsd: '0.5000000000',
    inputTokens: 5000,
    occurredAt: '2026-10-15T12:00:00Z',
  });
  await insertLedgerRow({
    tenantId: tenantA,
    runId: runA,
    stage: 'reporting',
    persona: 'reporter',
    costUsd: '0',
    inputTokens: 0,
    needsPricing: true,
    occurredAt: '2026-10-02T09:00:00Z',
  });
  // Tenant B, its own run and an October row. Tenant A must never see either.
  await insertLedgerRow({
    tenantId: tenantB,
    runId: runB,
    stage: 'execution',
    persona: 'planner',
    costUsd: '0.2500000000',
    inputTokens: 700,
    occurredAt: '2026-10-05T00:00:00Z',
  });
}, 180_000);

afterAll(async () => {
  await (pgHandle as PostgresHandle | undefined)?.stop();
});

describe('run aggregates (COST-003)', () => {
  it('runCost equals the exact sum of its ledger rows, with token totals', async () => {
    const total = await aggregates.runCost(tenantA, runA);
    expect(total.runId).toBe(runA);
    expect(total.ledgerRows).toBe(4);
    expect(total.costUsd).toBe(sumDecimal(['0.1234567890', '0.0000000001', '0.5000000000', '0']));
    expect(total.inputTokens).toBe(6010);
    expect(total.outputTokens).toBe(200);
    expect(total.cacheReadTokens).toBe(50);
    expect(total.cacheWriteTokens).toBe(0);
  });

  it('stage and persona breakdowns each sum to the run total', async () => {
    const total = await aggregates.runCost(tenantA, runA);
    const stages = await aggregates.runStageCost(tenantA, runA);
    const personas = await aggregates.runPersonaCost(tenantA, runA);

    expect(stages.map((row) => row.stage)).toEqual(['execution', 'recon', 'reporting']);
    expect(sumDecimal(stages.map((row) => row.costUsd))).toBe(total.costUsd);
    expect(stages.reduce((acc, row) => acc + row.ledgerRows, 0)).toBe(total.ledgerRows);

    expect(sumDecimal(personas.map((row) => row.costUsd))).toBe(total.costUsd);
    expect(personas.reduce((acc, row) => acc + row.inputTokens, 0)).toBe(total.inputTokens);
    const byPersona = new Map(personas.map((row) => [row.persona, row.costUsd]));
    expect(byPersona.get('recon-agent')).toBe('0.1234567890');
    expect(byPersona.get('planner')).toBe('0.0000000001');
    // Orchestrator overhead with no persona is a null group, not dropped.
    expect(byPersona.get(null)).toBe('0.5000000000');
  });

  it('an empty run is zero totals and empty breakdowns, never null', async () => {
    expect(await aggregates.runCost(tenantA, runEmpty)).toEqual({
      runId: runEmpty,
      ledgerRows: 0,
      costUsd: '0',
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    });
    expect(await aggregates.runStageCost(tenantA, runEmpty)).toEqual([]);
    expect(await aggregates.runPersonaCost(tenantA, runEmpty)).toEqual([]);
  });

  it('refuses a negative (compensating) ledger row, so totals never net below the recorded spend', async () => {
    await expect(
      insertLedgerRow({
        tenantId: tenantA,
        runId: runA,
        stage: 'execution',
        persona: 'planner',
        costUsd: '-0.0000000001',
        inputTokens: 0,
        occurredAt: '2026-10-03T00:00:00Z',
      }),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await aggregates.runCost(tenantA, runA)).ledgerRows).toBe(4);
  });
});

describe('tenant month aggregates (COST-003)', () => {
  it('buckets by occurred_at in UTC by default, so a run spanning the edge splits across months', async () => {
    const september = await aggregates.tenantMonthCost(tenantA, '2026-09');
    expect(september.timeZone).toBe('UTC');
    expect(september.timeZoneSource).toBe('default');
    expect(september.costUsd).toBe('0.1234567890');
    expect(september.ledgerRows).toBe(1);

    const october = await aggregates.tenantMonthCost(tenantA, '2026-10');
    expect(october.ledgerRows).toBe(3);
    expect(october.costUsd).toBe(sumDecimal(['0.0000000001', '0.5000000000', '0']));
  });

  it('uses the tenant timezone for month edges: the same row moves month when the zone moves it', async () => {
    // 30 Sep 23:30Z is 01:30 on 1 October in Berlin (CEST), so the Berlin October window takes it.
    const berlinOctober = await aggregates.tenantMonthCost(tenantA, '2026-10', 'Europe/Berlin');
    expect(berlinOctober.timeZoneSource).toBe('tenant');
    expect(berlinOctober.ledgerRows).toBe(4);
    expect(berlinOctober.costUsd).toBe(sumDecimal(['0.1234567890', '0.0000000001', '0.5', '0']));

    const berlinSeptember = await aggregates.tenantMonthCost(tenantA, '2026-09', 'Europe/Berlin');
    expect(berlinSeptember.ledgerRows).toBe(0);
    expect(berlinSeptember.costUsd).toBe('0');
  });

  it('a tenant month with no rows is zero, not null', async () => {
    const empty = await aggregates.tenantMonthCost(tenantA, '2001-01');
    expect(empty.costUsd).toBe('0');
    expect(empty.ledgerRows).toBe(0);
  });
});

describe('cross-tenant denial (RLS)', () => {
  it('tenant B cannot aggregate tenant A runs, stages or personas', async () => {
    expect((await aggregates.runCost(tenantB, runA)).ledgerRows).toBe(0);
    expect(await aggregates.runStageCost(tenantB, runA)).toEqual([]);
    expect(await aggregates.runPersonaCost(tenantB, runA)).toEqual([]);
  });

  it('tenant A cannot aggregate tenant B runs', async () => {
    expect((await aggregates.runCost(tenantA, runB)).ledgerRows).toBe(0);
  });

  it('a tenant month total never includes another tenant rows', async () => {
    const bOctober = await aggregates.tenantMonthCost(tenantB, '2026-10');
    expect(bOctober.ledgerRows).toBe(1);
    expect(bOctober.costUsd).toBe('0.2500000000');
  });

  it('fails closed without a tenant context', async () => {
    await expect(aggregates.runCost('not-a-uuid', runA)).rejects.toMatchObject({
      code: 'TENANT_CONTEXT_MISSING',
    });
  });
});
