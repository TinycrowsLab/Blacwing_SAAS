// The Postgres signup store against the real migrations on Postgres (Testcontainers): atomic verify,
// single use, concurrent verify of one token, slug uniqueness under concurrent signups and rollback.
// Needs Docker; run with `pnpm --filter @blackwing/api test:int`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuditEmitter } from '@blackwing/audit';
import { createDatabase, type Database, migrateDatabase } from '@blackwing/db';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { PostgresSignupStore } from './postgres-store.js';
import { hashSignupToken, newSignupToken } from './token.js';

import type { PendingSignup, VerifySignupOutcome } from './ports.js';

let pgHandle: PostgresHandle;
let database: Database;
let store: PostgresSignupStore;

const NOW = new Date('2026-10-28T12:00:00.000Z');
const HOUR = 3_600_000;
/** `created_at` comes from the database clock, so the throttle window is measured on the real one. */
const throttle = (max: number) => ({ since: new Date(Date.now() - HOUR), max });
const THROTTLE = throttle(5);
let counter = 0;

/** A pending signup with a fresh token; returns the token too. */
function pending(overrides: Partial<PendingSignup> = {}): { signup: PendingSignup; token: string } {
  const token = newSignupToken();
  counter += 1;
  return {
    token,
    signup: {
      email: `owner${String(counter)}@acme.example`,
      orgName: 'Acme Security',
      desiredSlug: 'acme-security',
      tokenHash: hashSignupToken(token),
      expiresAt: new Date(NOW.getTime() + 24 * HOUR),
      ...overrides,
    },
  };
}

async function signupWithToken(overrides: Partial<PendingSignup> = {}) {
  const { signup, token } = pending(overrides);
  await store.request(signup, THROTTLE);
  return { signup, token };
}

const verify = (token: string, now = NOW): Promise<VerifySignupOutcome> =>
  store.verify({ tokenHash: hashSignupToken(token), now, region: 'eu-west-1' });

const scalar = async (text: string, values: unknown[] = []): Promise<unknown> => {
  const result = await pgHandle.ownerPool.query<{ v: unknown }>(text, values);
  return result.rows[0]?.v;
};

function created(outcome: VerifySignupOutcome) {
  if (outcome.kind !== 'created') throw new Error(`expected created, got ${outcome.kind}`);
  return outcome;
}

beforeAll(async () => {
  pgHandle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  database = createDatabase(pgHandle.appPool);
  store = new PostgresSignupStore({ db: database, audit: createAuditEmitter() });
});

afterAll(async () => {
  await pgHandle.stop();
});

describe('request', () => {
  it('stores only the token hash and the pending status', async () => {
    const { signup, token } = await signupWithToken();
    const rows = await pgHandle.ownerPool.query<Record<string, unknown>>(
      'SELECT * FROM signups WHERE email = $1',
      [signup.email],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      org_name: 'Acme Security',
      desired_slug: 'acme-security',
      token_hash: hashSignupToken(token),
      status: 'pending',
    });
    expect(JSON.stringify(rows.rows)).not.toContain(token);
  });

  it('treats addresses case-insensitively and cancels the earlier pending link', async () => {
    const first = await signupWithToken({ email: 'case@acme.example' });
    const second = await signupWithToken({ email: 'CASE@acme.example' });
    expect(
      await scalar('SELECT status AS v FROM signups WHERE token_hash = $1', [
        first.signup.tokenHash,
      ]),
    ).toBe('cancelled');
    expect(
      await scalar('SELECT status AS v FROM signups WHERE token_hash = $1', [
        second.signup.tokenHash,
      ]),
    ).toBe('pending');
    expect((await verify(first.token)).kind).toBe('invalid');
  });

  it('refuses past the per-address limit and stores nothing', async () => {
    const email = 'busy@acme.example';
    for (let i = 0; i < 3; i += 1) {
      expect(await store.request(pending({ email }).signup, throttle(3))).not.toBeNull();
    }
    expect(await store.request(pending({ email }).signup, throttle(3))).toBeNull();
    expect(await scalar('SELECT count(*)::int AS v FROM signups WHERE email = $1', [email])).toBe(
      3,
    );
  });

  it('holds the limit under concurrent requests for one address', async () => {
    const email = 'race@acme.example';
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.request(pending({ email }).signup, throttle(4))),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(4);
    expect(await scalar('SELECT count(*)::int AS v FROM signups WHERE email = $1', [email])).toBe(
      4,
    );
  });
});

describe('verify', () => {
  it('creates tenant, owner, membership and the audit events in one go', async () => {
    const { signup, token } = await signupWithToken({ email: 'ada@acme.example' });

    const outcome = created(await verify(token));

    expect(outcome.slug).toBe('acme-security');
    const tenant = await pgHandle.withTenant(
      outcome.tenantId,
      async (tx) => (await tx.query<Record<string, unknown>>('SELECT * FROM tenants')).rows,
    );
    expect(tenant).toHaveLength(1);
    expect(tenant[0]).toMatchObject({
      id: outcome.tenantId,
      slug: 'acme-security',
      name: 'Acme Security',
      status: 'active',
      region: 'eu-west-1',
      plan: 'free',
    });
    const user = await pgHandle.ownerPool.query<{ id: string; keycloak_sub: string }>(
      'SELECT id, keycloak_sub FROM users WHERE email = $1',
      [signup.email],
    );
    expect(user.rows[0]?.id).toBe(outcome.userId);
    expect(user.rows[0]?.keycloak_sub).toBe(`pending:${outcome.userId}`);
    const memberships = await pgHandle.withTenant(
      outcome.tenantId,
      async (tx) =>
        (
          await tx.query<{ user_id: string; roles: string[] }>(
            'SELECT user_id, roles FROM memberships',
          )
        ).rows,
    );
    expect(memberships).toEqual([{ user_id: outcome.userId, roles: ['org_admin'] }]);
    expect(
      await scalar('SELECT status AS v FROM signups WHERE token_hash = $1', [signup.tokenHash]),
    ).toBe('verified');
    const audit = await pgHandle.withTenant(
      outcome.tenantId,
      async (tx) =>
        (
          await tx.query<{ action: string; actor: unknown; target: unknown }>(
            'SELECT action, actor, target FROM audit_events ORDER BY seq',
          )
        ).rows,
    );
    expect(audit.map((row) => row.action)).toEqual(['signup.verified', 'tenant.created']);
    expect(audit[1]).toMatchObject({
      actor: { type: 'user', id: outcome.userId },
      target: { type: 'tenant', id: outcome.tenantId },
    });
    expect(JSON.stringify(audit)).not.toContain(signup.email);
  });

  it('is single use', async () => {
    const { token } = await signupWithToken();
    created(await verify(token));
    const usersBefore = await scalar('SELECT count(*)::int AS v FROM users');
    expect((await verify(token)).kind).toBe('invalid');
    expect(await scalar('SELECT count(*)::int AS v FROM users')).toBe(usersBefore);
  });

  it('rejects an unknown token and creates nothing', async () => {
    // A tenant is only ever created together with its owner, so the user count shows both.
    const usersBefore = await scalar('SELECT count(*)::int AS v FROM users');
    expect((await verify(newSignupToken())).kind).toBe('invalid');
    expect(await scalar('SELECT count(*)::int AS v FROM users')).toBe(usersBefore);
  });

  it('rejects an expired token, marks it expired and creates nothing', async () => {
    const { signup, token } = await signupWithToken({ expiresAt: new Date(NOW.getTime() + HOUR) });
    const users = await scalar('SELECT count(*)::int AS v FROM users');

    expect((await verify(token, new Date(NOW.getTime() + HOUR))).kind).toBe('invalid');

    expect(
      await scalar('SELECT status AS v FROM signups WHERE token_hash = $1', [signup.tokenHash]),
    ).toBe('expired');
    expect(await scalar('SELECT count(*)::int AS v FROM users')).toBe(users);
    expect((await verify(token)).kind).toBe('invalid');
  });

  it('creates exactly one tenant when one token is verified concurrently', async () => {
    const { signup, token } = await signupWithToken({
      email: 'twice@acme.example',
      desiredSlug: 'concurrent-token',
    });

    const outcomes = await Promise.all(Array.from({ length: 8 }, () => verify(token)));

    expect(outcomes.filter((o) => o.kind === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'invalid')).toHaveLength(7);
    const winner = created(outcomes.find((o) => o.kind === 'created') ?? { kind: 'invalid' });
    expect(winner.slug).toBe('concurrent-token');
    expect(
      await scalar('SELECT count(*)::int AS v FROM users WHERE email = $1', [signup.email]),
    ).toBe(1);
  });

  it('never creates a second tenant for an address that already has an account', async () => {
    const email = 'again@acme.example';
    const first = await signupWithToken({ email, desiredSlug: 'first-org' });
    const outcome = created(await verify(first.token));
    const second = await signupWithToken({ email, desiredSlug: 'second-org' });

    const result = await verify(second.token);

    expect(result.kind).toBe('existing_account');
    expect(await scalar('SELECT count(*)::int AS v FROM users WHERE email = $1', [email])).toBe(1);
    expect(
      await scalar('SELECT status AS v FROM signups WHERE token_hash = $1', [
        second.signup.tokenHash,
      ]),
    ).toBe('verified');
    expect(
      await pgHandle.withTenant(
        outcome.tenantId,
        async (tx) => (await tx.query('SELECT 1 FROM memberships')).rowCount,
      ),
    ).toBe(1);
  });

  it('gives concurrent signups for one organisation name distinct, gapless slugs', async () => {
    const signups = [];
    for (let i = 0; i < 6; i += 1) signups.push(await signupWithToken({ desiredSlug: 'squatter' }));

    const outcomes = await Promise.all(signups.map(({ token }) => verify(token)));

    const slugs = outcomes.map((o) => created(o).slug).toSorted();
    expect(slugs).toEqual(
      ['squatter', 'squatter-2', 'squatter-3', 'squatter-4', 'squatter-5', 'squatter-6'].toSorted(),
    );
    for (const outcome of outcomes) {
      const { tenantId, slug } = created(outcome);
      const rows = await pgHandle.withTenant(
        tenantId,
        async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM tenants')).rows,
      );
      expect(rows).toEqual([{ slug }]);
    }
  });

  it('keeps every slug within 40 characters when a long name collides', async () => {
    const long = 'l'.repeat(40);
    const a = await signupWithToken({ desiredSlug: long });
    const b = await signupWithToken({ desiredSlug: long });
    const slugs = [created(await verify(a.token)).slug, created(await verify(b.token)).slug];
    expect(slugs[0]).toBe(long);
    expect(slugs[1]).toBe(`${'l'.repeat(38)}-2`);
  });

  it('rolls everything back, token included, when a step fails (the retry then works)', async () => {
    const { signup, token } = await signupWithToken({ email: 'rollback@acme.example' });
    const failing = new PostgresSignupStore({
      db: database,
      audit: {
        emitAuditInTx: () => Promise.reject(new Error('ledger unavailable')),
      },
    });

    await expect(
      failing.verify({ tokenHash: hashSignupToken(token), now: NOW, region: 'eu-west-1' }),
    ).rejects.toThrow('ledger unavailable');

    expect(
      await scalar('SELECT count(*)::int AS v FROM users WHERE email = $1', [signup.email]),
    ).toBe(0);
    expect(
      await scalar('SELECT status AS v FROM signups WHERE token_hash = $1', [signup.tokenHash]),
    ).toBe('pending');
    created(await verify(token));
  });
});

describe('table guards', () => {
  it('rejects a token hash that is not 64 lower-case hex characters', async () => {
    await expect(
      pgHandle.appPool.query(
        `INSERT INTO signups (email, org_name, token_hash, expires_at) VALUES ('x@y.example', 'X Org', 'plain-token', now())`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an unknown status', async () => {
    await expect(
      pgHandle.appPool.query(
        `INSERT INTO signups (email, org_name, token_hash, expires_at, status) VALUES ('x@y.example', 'X Org', $1, now(), 'done')`,
        ['a'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
