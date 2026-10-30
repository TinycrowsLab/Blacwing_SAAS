// The DNS probe's Postgres store against the real migrations (Testcontainers, Postgres 16): a matched answer verifies
// the asset with method dns_txt, a miss retries and then fails within the budget, a settled or expired challenge is
// ignored, and tenant B can neither read nor apply tenant A's challenge (RLS, fail closed).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database, migrateDatabase } from '@blackwing/db';
import { newVerificationToken, type VerificationPolicy } from '@blackwing/domain';
import { newId, toPublicId } from '@blackwing/ids';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createPgVerificationDnsStore } from './store-pg.js';

let pgHandle: PostgresHandle;
let appDb: Database;

const tenantA = newId();
const tenantB = newId();
const owner = newId();
const NOW = new Date('2026-10-30T10:00:00.000Z');
const LATER = new Date('2026-11-02T10:00:00.000Z');
const POLICY: VerificationPolicy = {
  verificationTtlDays: 90,
  challengeTtlHours: 72,
  maxCheckAttempts: 2,
  rotateOnRestart: true,
};

interface Seeded {
  readonly assetId: string;
  readonly challengeId: string;
  readonly token: string;
}

/** A pending asset with an open dns_txt challenge in `tenantId`. */
async function seed(tenantId: string, options: { expiresAt?: Date } = {}): Promise<Seeded> {
  const assetId = newId();
  const challengeId = newId();
  const token = newVerificationToken();
  const expiresAt = options.expiresAt ?? LATER;
  await pgHandle.withTenant(tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO assets (id, tenant_id, public_id, type, name, identifiers, environment, owner_user_id,
         verification_status)
       VALUES ($1, $2, $3, 'web_app', 'Portal', $4::jsonb, 'staging', $5, 'pending')`,
      [
        assetId,
        tenantId,
        toPublicId(assetId, 'asset'),
        JSON.stringify([{ kind: 'host', value: 'portal.example.com' }]),
        owner,
      ],
    );
    await tx.query(
      `INSERT INTO verification_challenges (id, tenant_id, asset_id, method, token, expected_location, status,
         attempts, expires_at)
       VALUES ($1, $2, $3, 'dns_txt', $4, '_blackwing-challenge.portal.example.com', 'pending', 0, $5)`,
      [challengeId, tenantId, assetId, token, expiresAt],
    );
  });
  return { assetId, challengeId, token };
}

async function assetRow(tenantId: string, assetId: string) {
  const { rows } = await pgHandle.withTenant(tenantId, (tx) =>
    tx.query(
      'SELECT verification_status, verification_method, verified_at FROM assets WHERE id = $1',
      [assetId],
    ),
  );
  return rows[0] as {
    verification_status: string;
    verification_method: string | null;
    verified_at: Date | null;
  };
}

async function challengeRow(tenantId: string, challengeId: string) {
  const { rows } = await pgHandle.withTenant(tenantId, (tx) =>
    tx.query('SELECT status, attempts FROM verification_challenges WHERE id = $1', [challengeId]),
  );
  return rows[0] as { status: string; attempts: number };
}

async function auditActions(tenantId: string): Promise<string[]> {
  const { rows } = await pgHandle.withTenant(tenantId, (tx) =>
    tx.query('SELECT action FROM audit_events ORDER BY seq'),
  );
  return (rows as { action: string }[]).map((row) => row.action);
}

beforeAll(async () => {
  pgHandle = await withPostgres({ migrations: (ownerPool) => migrateDatabase(ownerPool) });
  appDb = createDatabase(pgHandle.appPool);
  await pgHandle.ownerPool.query(
    'INSERT INTO users (id, keycloak_sub, email) VALUES ($1, $2, $3)',
    [owner, `dns-owner-${owner}`, `dns-owner-${owner}@example.test`],
  );
}, 180_000);

afterAll(async () => {
  await (pgHandle as PostgresHandle | undefined)?.stop();
});

describe('DNS probe store (ASSET-005)', () => {
  it('a matched answer verifies the asset with method dns_txt and records the pass', async () => {
    const seeded = await seed(tenantA);
    const store = createPgVerificationDnsStore(appDb, POLICY);

    const outcome = await store.apply({
      tenantId: tenantA,
      challengeId: seeded.challengeId,
      matched: true,
      at: NOW,
    });

    expect(outcome).toBe('passed');
    expect(await assetRow(tenantA, seeded.assetId)).toEqual({
      verification_status: 'verified',
      verification_method: 'dns_txt',
      verified_at: NOW,
    });
    expect(await challengeRow(tenantA, seeded.challengeId)).toEqual({
      status: 'passed',
      attempts: 1,
    });
    expect(await auditActions(tenantA)).toContain('asset.verification_passed');
  });

  it('a miss within the budget keeps the challenge open and counts the attempt', async () => {
    const seeded = await seed(tenantA);
    const store = createPgVerificationDnsStore(appDb, POLICY);

    const outcome = await store.apply({
      tenantId: tenantA,
      challengeId: seeded.challengeId,
      matched: false,
      at: NOW,
    });

    expect(outcome).toBe('retry');
    expect(await challengeRow(tenantA, seeded.challengeId)).toEqual({
      status: 'pending',
      attempts: 1,
    });
    expect((await assetRow(tenantA, seeded.assetId)).verification_status).toBe('pending');
  });

  it('a miss that spends the budget fails the challenge and returns the asset to unverified', async () => {
    const seeded = await seed(tenantA);
    const store = createPgVerificationDnsStore(appDb, POLICY);

    await store.apply({
      tenantId: tenantA,
      challengeId: seeded.challengeId,
      matched: false,
      at: NOW,
    });
    const outcome = await store.apply({
      tenantId: tenantA,
      challengeId: seeded.challengeId,
      matched: false,
      at: NOW,
    });

    expect(outcome).toBe('failed');
    expect(await challengeRow(tenantA, seeded.challengeId)).toEqual({
      status: 'failed',
      attempts: 2,
    });
    expect((await assetRow(tenantA, seeded.assetId)).verification_status).toBe('unverified');
    expect(await auditActions(tenantA)).toContain('asset.verification_failed');
  });

  it('an expired challenge is ignored and changes nothing', async () => {
    const seeded = await seed(tenantA, { expiresAt: NOW });
    const store = createPgVerificationDnsStore(appDb, POLICY);

    const outcome = await store.apply({
      tenantId: tenantA,
      challengeId: seeded.challengeId,
      matched: true,
      at: NOW,
    });

    expect(outcome).toBe('ignored');
    expect((await assetRow(tenantA, seeded.assetId)).verification_status).toBe('pending');
  });

  it('an answer for a challenge already settled is ignored (idempotent re-run)', async () => {
    const seeded = await seed(tenantA);
    const store = createPgVerificationDnsStore(appDb, POLICY);
    await store.apply({
      tenantId: tenantA,
      challengeId: seeded.challengeId,
      matched: true,
      at: NOW,
    });

    const again = await store.apply({
      tenantId: tenantA,
      challengeId: seeded.challengeId,
      matched: false,
      at: NOW,
    });

    expect(again).toBe('ignored');
    expect(await challengeRow(tenantA, seeded.challengeId)).toEqual({
      status: 'passed',
      attempts: 1,
    });
  });

  it('tenant B cannot load tenant A challenge', async () => {
    const seeded = await seed(tenantA);
    const store = createPgVerificationDnsStore(appDb, POLICY);

    expect(await store.load(tenantB, seeded.challengeId)).toBeUndefined();
    const own = await store.load(tenantA, seeded.challengeId);
    expect(own).toMatchObject({
      challengeId: seeded.challengeId,
      method: 'dns_txt',
      status: 'pending',
      expectedLocation: '_blackwing-challenge.portal.example.com',
    });
  });

  it('tenant B cannot apply an answer to tenant A challenge, and tenant A is untouched', async () => {
    const seeded = await seed(tenantA);
    const store = createPgVerificationDnsStore(appDb, POLICY);

    const outcome = await store.apply({
      tenantId: tenantB,
      challengeId: seeded.challengeId,
      matched: true,
      at: NOW,
    });

    expect(outcome).toBe('ignored');
    expect((await assetRow(tenantA, seeded.assetId)).verification_status).toBe('pending');
    expect(await challengeRow(tenantA, seeded.challengeId)).toEqual({
      status: 'pending',
      attempts: 0,
    });
  });
});
