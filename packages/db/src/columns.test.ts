// columns: unit tests for the base column mixins (DB-004). Database behaviour is in columns.int.test.ts.

import { getTableConfig, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { isIdValidationError, isUuidV7, newId, ID_PREFIX_LIST } from '@blackwing/ids';

import {
  activeViewSql,
  fromPublicId,
  idColumn,
  publicId,
  retention,
  softDelete,
  stateVersion,
  tenantIdColumn,
  tenantIdIndex,
  timestamps,
  updatedAtTriggerSql,
} from './columns.js';

const tenants = pgTable('tenants', { id: idColumn() });
const sample = pgTable(
  'sample',
  {
    id: idColumn(),
    tenantId: tenantIdColumn({ references: () => tenants.id }),
    name: text('name').notNull(),
    ...timestamps(),
    ...stateVersion(),
    ...softDelete(),
    ...retention(),
  },
  (t) => [tenantIdIndex('sample', t.tenantId)],
);

describe('column mixins', () => {
  const config = getTableConfig(sample);
  const column = (name: string) => {
    const found = config.columns.find((c) => c.name === name);
    if (!found) throw new Error(`missing column ${name}`);
    return found;
  };

  it('declares the expected columns, types, nullability and defaults', () => {
    expect(config.columns.map((c) => c.name)).toEqual([
      'id',
      'tenant_id',
      'name',
      'created_at',
      'updated_at',
      'state_version',
      'deleted_at',
      'retention_until',
      'legal_hold',
    ]);
    expect(column('id')).toMatchObject({ columnType: 'PgUUID', primary: true, notNull: true });
    expect(column('tenant_id')).toMatchObject({ columnType: 'PgUUID', notNull: true });
    expect(column('created_at')).toMatchObject({ notNull: true, hasDefault: true });
    expect(column('updated_at')).toMatchObject({ notNull: true, hasDefault: true });
    expect(column('state_version')).toMatchObject({ notNull: true, default: 0 });
    expect(column('deleted_at').notNull).toBe(false);
    expect(column('retention_until').notNull).toBe(false);
    expect(column('legal_hold')).toMatchObject({ notNull: true, default: false });
  });

  it('indexes tenant_id and references tenants(id)', () => {
    expect(config.indexes.map((i) => i.config.name)).toEqual(['sample_tenant_id_idx']);
    expect(config.foreignKeys).toHaveLength(1);
  });

  it('generates UUIDv7 app-side, with a DB fallback default', () => {
    const generated = column('id').defaultFn?.();
    expect(isUuidV7(generated)).toBe(true);
    expect(column('id').hasDefault).toBe(true);
  });

  it('keeps ids monotonic under rapid generation', () => {
    const ids = Array.from({ length: 5000 }, () => column('id').defaultFn?.() as string);
    expect(ids).toEqual(ids.toSorted());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives each call fresh column builders (no shared state between tables)', () => {
    expect(timestamps().createdAt).not.toBe(timestamps().createdAt);
  });
});

describe('publicId', () => {
  it('is stable and reversible for every registered prefix', () => {
    for (const prefix of ID_PREFIX_LIST) {
      const uuid = newId();
      const id = publicId(prefix, uuid);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(publicId(prefix, uuid)).toBe(id);
      expect(fromPublicId(id)).toBe(uuid);
      expect(fromPublicId(id, prefix)).toBe(uuid);
    }
  });

  it('rejects a wrong prefix and malformed values', () => {
    const id = publicId('run', newId());
    expect(() => fromPublicId(id, 'fnd')).toThrow();
    const failure = (() => {
      try {
        return fromPublicId('run_nope');
      } catch (error) {
        return error;
      }
    })();
    expect(isIdValidationError(failure)).toBe(true);
  });
});

describe('DDL generators', () => {
  it('builds the updated_at trigger and active view', () => {
    expect(updatedAtTriggerSql('runs')).toBe(
      'CREATE TRIGGER runs_set_updated_at BEFORE UPDATE ON runs FOR EACH ROW EXECUTE FUNCTION bw_set_updated_at();',
    );
    expect(activeViewSql('runs')).toBe(
      'CREATE VIEW runs_active WITH (security_invoker = true) AS SELECT * FROM runs WHERE deleted_at IS NULL;',
    );
  });

  it('refuses identifiers that could inject SQL', () => {
    expect(() => updatedAtTriggerSql('runs; DROP TABLE x')).toThrow(TypeError);
    expect(() => activeViewSql('runs', 'v" --')).toThrow(TypeError);
  });
});
