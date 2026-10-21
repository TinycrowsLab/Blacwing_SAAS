import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { membershipSchema, tenantSchema, userSchema } from '@blackwing/contracts';
import { newId } from '@blackwing/ids';

import { fromPublicId } from '../columns.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { RLS_PREDICATE, rlsPolicySql, STATEMENT_BREAKPOINT } from '../rls.js';
import { memberships, tenantPublicId, tenants, userPublicId, users } from './tenancy.js';

const migration = (): string => {
  const name = migrationNames().find((tag) => tag.endsWith('_tenancy'));
  if (!name) throw new Error('tenancy migration not found');
  return readFileSync(`${MIGRATIONS_DIR}${name}.sql`, 'utf8');
};

const columnsOf = (table: Parameters<typeof getTableConfig>[0]) =>
  Object.fromEntries(getTableConfig(table).columns.map((column) => [column.name, column]));

describe('tenancy tables', () => {
  it('tenants has the §7 columns, types and defaults', () => {
    const cols = columnsOf(tenants);
    expect(Object.keys(cols)).toEqual([
      'id',
      'slug',
      'name',
      'status',
      'region',
      'plan',
      'created_at',
      'updated_at',
    ]);
    expect(cols.id).toMatchObject({ columnType: 'PgUUID', primary: true });
    for (const name of ['slug', 'name', 'status', 'region', 'plan', 'created_at', 'updated_at']) {
      expect(cols[name]?.notNull, name).toBe(true);
    }
    expect(cols.status?.default).toBe('active');
    expect(cols.plan?.default).toBe('free');
  });

  it('users is global: citext email, nullable name, no tenant_id', () => {
    const cols = columnsOf(users);
    expect(Object.keys(cols)).toEqual([
      'id',
      'keycloak_sub',
      'email',
      'name',
      'status',
      'created_at',
      'updated_at',
    ]);
    expect(cols.email?.getSQLType()).toBe('citext');
    expect(cols.email?.notNull).toBe(true);
    expect(cols.keycloak_sub?.notNull).toBe(true);
    expect(cols.name?.notNull).toBe(false);
    expect(cols.status?.default).toBe('active');
    expect(cols.tenant_id).toBeUndefined();
    expect(getTableConfig(users).policies).toEqual([]);
  });

  it('memberships has the composite primary key, both foreign keys and the user_id index', () => {
    const config = getTableConfig(memberships);
    expect(config.columns.map((c) => c.name)).toEqual([
      'tenant_id',
      'user_id',
      'roles',
      'created_at',
      'updated_at',
    ]);
    const roles = config.columns.find((c) => c.name === 'roles');
    expect(roles?.getSQLType()).toBe('text[]');
    expect(roles?.notNull).toBe(true);
    expect(config.primaryKeys[0]?.columns.map((c) => c.name)).toEqual(['tenant_id', 'user_id']);
    expect(
      config.foreignKeys.map((fk) => getTableConfig(fk.reference().foreignTable).name).sort(),
    ).toEqual(['tenants', 'users']);
    expect(config.indexes.map((i) => i.config.name)).toContain('memberships_user_id_idx');
  });

  it('row types line up with the Zod contracts', () => {
    const now = new Date();
    const tenantRow = {
      id: newId(),
      slug: 'acme',
      name: 'Acme',
      status: 'active' as const,
      region: 'eu-west-1',
      plan: 'free',
      createdAt: now,
      updatedAt: now,
    };
    expect(
      tenantSchema.parse({
        ...tenantRow,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }),
    ).toMatchObject({ slug: 'acme' });
    expect(
      userSchema.safeParse({
        id: newId(),
        keycloakSub: 'sub',
        email: 'a@example.test',
        name: null,
        status: 'active',
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }).success,
    ).toBe(true);
    expect(
      membershipSchema.safeParse({
        tenantId: newId(),
        userId: newId(),
        roles: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }).success,
    ).toBe(true);
  });

  it('public ids round-trip with their prefix', () => {
    const id = newId();
    expect(tenantPublicId(id)).toMatch(/^ten_/);
    expect(userPublicId(id)).toMatch(/^usr_/);
    expect(fromPublicId(tenantPublicId(id), 'ten')).toBe(id);
    expect(() => fromPublicId(userPublicId(id), 'ten')).toThrow();
  });
});

describe('tenancy migration', () => {
  it('installs memberships RLS with the output of rlsPolicySql, verbatim', () => {
    const block = rlsPolicySql('memberships').split('\n').join(`${STATEMENT_BREAKPOINT}\n`);
    expect(migration()).toContain(block);
  });

  it('tenants gets the same shape keyed on id, with the identical fail-closed expression', () => {
    const sqlText = migration();
    const idPredicate = RLS_PREDICATE.replace('tenant_id', 'id');
    expect(sqlText).toContain('ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;');
    expect(sqlText).toContain('ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;');
    expect(sqlText).toContain(
      `CREATE POLICY "tenants_tenant_isolation" ON "tenants" AS PERMISSIVE FOR ALL USING (${idPredicate}) WITH CHECK (${idPredicate});`,
    );
    expect(sqlText).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON "tenants" TO bw_app;');
  });

  it('never uses the missing-ok form of current_setting and never touches the roles', () => {
    const sqlText = migration();
    expect(sqlText).not.toMatch(/current_setting\([^)]*,\s*(true|false)\s*\)/i);
    expect(sqlText).not.toMatch(/(CREATE|ALTER|DROP)\s+ROLE|BYPASSRLS|TRUNCATE/i);
    expect(sqlText).not.toMatch(/\bTO\s+PUBLIC\b/i);
  });

  it('is forward-only: no destructive statement', () => {
    expect(migration()).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
  });
});
