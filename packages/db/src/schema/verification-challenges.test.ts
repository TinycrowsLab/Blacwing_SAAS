import { readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { stripSqlComments } from '../migrate-guard.js';
import { MIGRATIONS_DIR, migrationNames } from '../migrate.js';
import { verificationChallenges } from './assets.js';

const migrationName =
  migrationNames().find((name) => name.endsWith('_asset_verification_challenges')) ?? '';
const code = stripSqlComments(readFileSync(`${MIGRATIONS_DIR}${migrationName}.sql`, 'utf8'));

describe('verification challenge schema (ASSET-003)', () => {
  it('has every column of the issue, with the right nullability', () => {
    const expected: Record<string, boolean> = {
      id: true,
      tenant_id: true,
      asset_id: true,
      method: true,
      token: true,
      expected_location: false,
      status: true,
      attempts: true,
      expires_at: true,
      last_checked_at: false,
      created_at: true,
      updated_at: true,
    };
    const config = getTableConfig(verificationChallenges);
    expect(config.columns.map((c) => c.name).toSorted()).toEqual(Object.keys(expected).toSorted());
    for (const [name, notNull] of Object.entries(expected)) {
      expect(config.columns.find((c) => c.name === name)?.notNull, name).toBe(notNull);
    }
  });

  it('allows at most one pending challenge per asset (a partial unique index)', () => {
    const config = getTableConfig(verificationChallenges);
    const index = config.indexes.find(
      (i) => i.config.name === 'verification_challenges_one_pending_per_asset_key',
    );
    expect(index?.config.unique).toBe(true);
    expect(index?.config.where).toBeDefined();
    expect(code).toMatch(
      /CREATE UNIQUE INDEX "verification_challenges_one_pending_per_asset_key" ON "verification_challenges" USING btree \("asset_id"\) WHERE "verification_challenges"\."status" = 'pending'/,
    );
  });

  it('ties each challenge to its asset with a composite, tenant-keyed foreign key', () => {
    const config = getTableConfig(verificationChallenges);
    const fk = config.foreignKeys.find((f) => f.getName() === 'verification_challenges_asset_fk');
    expect(fk?.reference().columns.map((c) => c.name)).toEqual(['tenant_id', 'asset_id']);
    expect(fk?.reference().foreignColumns.map((c) => c.name)).toEqual(['tenant_id', 'id']);
  });

  it('carries the tenant policy, FORCE RLS, grants without DELETE, and the updated_at trigger', () => {
    const config = getTableConfig(verificationChallenges);
    expect(config.policies.map((p) => p.name)).toEqual([
      'verification_challenges_tenant_isolation',
    ]);
    expect(code).toContain('ALTER TABLE "verification_challenges" FORCE ROW LEVEL SECURITY;');
    expect(code).toContain('GRANT SELECT, INSERT, UPDATE ON "verification_challenges" TO bw_app;');
    expect(code).toContain('REVOKE DELETE, TRUNCATE ON "verification_challenges" FROM bw_app;');
    expect(code).toContain(
      'CREATE TRIGGER verification_challenges_set_updated_at BEFORE UPDATE ON verification_challenges',
    );
  });

  it('refuses a token that is not the prefixed, full-entropy form (database CHECK)', () => {
    expect(code).toContain(
      'starts_with("verification_challenges"."token", \'blackwing-site-verification=\')',
    );
    expect(code).toMatch(/length\("verification_challenges"\."token"\) >= 80/);
  });
});
