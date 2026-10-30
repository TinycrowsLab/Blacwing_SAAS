import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { COST_PROVIDERS, COST_STAGES } from '@blackwing/contracts';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { costLedger, priceTables } from './cost.js';

const migrationName =
  migrationNames().find((name) => name.endsWith('_cost_ledger_and_price_tables')) ?? '';
const code = stripSqlComments(readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8'));

describe('cost ledger schema (COST-001)', () => {
  it('has every column of the issue, with the right nullability', () => {
    const expected: Record<string, boolean> = {
      id: true,
      tenant_id: true,
      run_id: false,
      subtask_id: false,
      agent_session_id: false,
      stage: true,
      persona: false,
      provider: true,
      model: true,
      price_table_id: false,
      needs_pricing: true,
      input_tokens: true,
      output_tokens: true,
      cache_write_tokens: true,
      cache_read_tokens: true,
      cost_usd: true,
      usage_event_id: true,
      occurred_at: true,
      created_at: true,
      updated_at: true,
    };
    const config = getTableConfig(costLedger);
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(config.columns.find((c) => c.name === name)?.notNull, name).toBe(notNull);
    }
  });

  it('keeps money as numeric, never float', () => {
    const cost = getTableConfig(costLedger).columns.find((c) => c.name === 'cost_usd');
    expect(cost?.getSQLType()).toBe('numeric(18, 10)');
    expect(code).toMatch(/"cost_usd" numeric\(18, 10\) NOT NULL/);
  });

  it('is idempotent per tenant on the gateway usage event id', () => {
    const config = getTableConfig(costLedger);
    expect(config.uniqueConstraints.map((u) => u.name)).toContain(
      'cost_ledger_tenant_usage_event_key',
    );
    expect(code).toMatch(
      /CONSTRAINT "cost_ledger_tenant_usage_event_key" UNIQUE\("tenant_id","usage_event_id"\)/,
    );
  });

  it('indexes tenant plus run, occurred_at and model, and the price table pin', () => {
    const names = getTableConfig(costLedger).indexes.map((i) => i.config.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'cost_ledger_tenant_id_idx',
        'cost_ledger_tenant_run_idx',
        'cost_ledger_tenant_occurred_at_idx',
        'cost_ledger_tenant_model_idx',
        'cost_ledger_price_table_idx',
      ]),
    );
  });

  it('pins every row to a price table with a real foreign key (§8.9)', () => {
    const fk = getTableConfig(costLedger).foreignKeys.map((f) => f.reference().foreignTable);
    expect(fk).toEqual([priceTables]);
    expect(code).toMatch(
      /ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_price_table_id_price_tables_id_fk" FOREIGN KEY \("price_table_id"\) REFERENCES "public"\."price_tables"\("id"\)/,
    );
  });

  it('enforces the stage and provider enums from @blackwing/contracts in the database', () => {
    const stages = COST_STAGES.map((s) => `'${s}'`).join(', ');
    const providers = COST_PROVIDERS.map((p) => `'${p}'`).join(', ');
    expect(code).toContain(`"cost_ledger"."stage" IN (${stages})`);
    expect(code).toContain(`"cost_ledger"."provider" IN (${providers})`);
    expect(code).toContain(`"price_tables"."provider" IN (${providers})`);
  });

  it('carries the tenant policy, FORCE RLS, and an append-only grant (no UPDATE, DELETE or TRUNCATE)', () => {
    expect(getTableConfig(costLedger).policies.map((p) => p.name)).toEqual([
      'cost_ledger_tenant_isolation',
    ]);
    expect(code).toContain('ALTER TABLE "cost_ledger" FORCE ROW LEVEL SECURITY');
    expect(code).toContain('GRANT SELECT, INSERT ON "cost_ledger" TO bw_app');
    expect(code).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON "cost_ledger" FROM bw_app');
  });
});

describe('price table schema (COST-001)', () => {
  it('is unique per (provider, model, version)', () => {
    expect(getTableConfig(priceTables).uniqueConstraints.map((u) => u.name)).toContain(
      'price_tables_provider_model_version_key',
    );
    expect(code).toMatch(
      /CONSTRAINT "price_tables_provider_model_version_key" UNIQUE\("provider","model","version"\)/,
    );
  });

  it('is not tenant data: no tenant_id, readable by tenants, writable only by the operator role', () => {
    expect(getTableConfig(priceTables).columns.map((c) => c.name)).not.toContain('tenant_id');
    expect(getTableConfig(priceTables).policies.map((p) => p.name)).toEqual([
      'price_tables_read',
      'price_tables_operator_write',
    ]);
    expect(code).toContain(
      'CREATE POLICY "price_tables_read" ON "price_tables" AS PERMISSIVE FOR SELECT TO public USING (true)',
    );
    expect(code).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "price_tables" FROM bw_app');
    expect(code).toContain('GRANT SELECT, INSERT, UPDATE ON "price_tables" TO bw_operator');
    expect(code).toContain('ALTER TABLE "price_tables" FORCE ROW LEVEL SECURITY');
  });

  it('restricts model ids to exact ids without a date suffix', () => {
    expect(code).toContain(`"model" !~ '-[0-9]{8}$'`);
    expect(code).toContain(`"model" ~ '^[a-z0-9][a-z0-9.-]*$'`);
  });
});
