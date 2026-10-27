import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { OUTBOX_DEDUPE_INDEX, outbox } from './outbox.js';

const migrationName = migrationNames().find((name) => name.endsWith('_outbox')) ?? '';
const migration = readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8');
const code = stripSqlComments(migration);

const columnNames = (columns: readonly unknown[]): unknown[] =>
  columns.map((c) => (c as { name?: string }).name);

describe('outbox schema', () => {
  const config = getTableConfig(outbox);
  const column = (name: string) => config.columns.find((c) => c.name === name);

  it('has every column of the issue with the right nullability', () => {
    expect(config.name).toBe('outbox');
    const expected: Record<string, boolean> = {
      id: true,
      tenant_id: true,
      aggregate_type: false,
      aggregate_id: false,
      type: true,
      payload: true,
      dedupe_key: false,
      status: true,
      attempts: true,
      available_at: true,
      created_at: true,
      updated_at: true,
      dispatched_at: false,
      last_error: false,
    };
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(column(name)?.notNull, name).toBe(notNull);
    }
    expect(column('id')?.primary).toBe(true);
    expect(column('status')?.default).toBe('pending');
    expect(column('attempts')?.default).toBe(0);
  });

  it('indexes (status, available_at) and uniquely (tenant_id, dedupe_key) where the key is set', () => {
    const index = (name: string) => config.indexes.find((i) => i.config.name === name)?.config;
    expect(columnNames(index('outbox_status_available_at_idx')?.columns ?? [])).toEqual([
      'status',
      'available_at',
    ]);
    const dedupe = index(OUTBOX_DEDUPE_INDEX);
    expect(dedupe?.unique).toBe(true);
    expect(columnNames(dedupe?.columns ?? [])).toEqual(['tenant_id', 'dedupe_key']);
    expect(dedupe?.where).toBeDefined();
  });

  it('carries the canonical tenant policy and the two relay policies', () => {
    expect(config.policies.map((p) => p.name).toSorted()).toEqual([
      'outbox_relay_select',
      'outbox_relay_update',
      'outbox_tenant_isolation',
    ]);
  });
});

describe('outbox migration', () => {
  it('exists, is timestamp-named and is the newest migration', () => {
    expect(migrationName).toMatch(/^\d{14}_outbox$/);
  });

  it('is forward-only', () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b/i);
  });

  it('enables and forces RLS with the fail-closed predicate (no missing_ok)', () => {
    expect(migration).toContain('ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY');
    expect(migration).toContain("USING (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(migration).toContain("WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid)");
    expect(migration).not.toMatch(/current_setting\('app\.tenant_id',\s*true\)/);
  });

  it('grants DML to bw_app only: not PUBLIC, no TRUNCATE, no BYPASSRLS', () => {
    expect(migration).toContain('REVOKE ALL ON "outbox" FROM PUBLIC');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox" TO bw_app');
    expect(code).not.toMatch(/TRUNCATE|BYPASSRLS/i);
  });

  it('caps the payload and the dedupe key in the database', () => {
    expect(migration).toContain('octet_length("outbox"."payload"::text) <= 65536');
    expect(migration).toContain('jsonb_typeof("outbox"."payload") = \'object\'');
    expect(migration).toContain('BETWEEN 1 AND 255');
  });

  it('defaults available_at to the database clock', () => {
    expect(migration).toContain('"available_at" timestamp with time zone DEFAULT now() NOT NULL');
  });
});

describe('outbox relay migration', () => {
  const relayName = migrationNames().find((name) => name.endsWith('_outbox_relay')) ?? '';
  const relay = readFileSync(`${MIGRATIONS_DIR}${relayName}.sql`, 'utf8');
  const relayCode = stripSqlComments(relay);

  it('is a later migration than the outbox table', () => {
    expect(relayName).toMatch(/^\d{14}_outbox_relay$/);
    expect(relayName > migrationName).toBe(true);
  });

  it('gives the relay role read access and update of the delivery columns only', () => {
    expect(relayCode).toContain('REVOKE ALL ON "outbox" FROM bw_relay');
    expect(relayCode).toContain('GRANT SELECT ON "outbox" TO bw_relay');
    expect(relayCode).toContain(
      'GRANT UPDATE ("status", "attempts", "available_at", "dispatched_at", "last_error") ON "outbox" TO bw_relay',
    );
    expect(relayCode).not.toMatch(/GRANT[^;]*\b(INSERT|DELETE|TRUNCATE|ALL)\b[^;]*TO bw_relay/i);
    expect(relayCode).not.toMatch(/TO\s+(PUBLIC|bw_app)/i);
  });

  it('confines relay updates to pending rows and never weakens FORCE RLS', () => {
    expect(relayCode).toContain('FOR UPDATE TO "bw_relay" USING ("outbox"."status" = \'pending\')');
    expect(relayCode).not.toMatch(/NO\s+FORCE|DISABLE\s+ROW|BYPASSRLS|DROP\s+POLICY/i);
  });
});
