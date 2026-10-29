import { describe, expect, it } from 'vitest';

import { isAppError } from '@blackwing/errors';
import { isUuidV7, newId, type Uuid } from '@blackwing/ids';
import { fromIso, type IsoTimestamp } from '@blackwing/time';

import { assertSeedAllowed, expandEnv, SeedForbiddenInProdError, seedEnvSchema } from './env.js';
import { lookupSubjects } from './keycloak.js';
import {
  assertSecretRef,
  assertSeparationOfDuties,
  buildTenantSeedPlan,
  devSign,
  PERSONA_KEYS,
  type PersonaKey,
  SEED_LAB_CIDR,
  SEED_PERSONAS,
  seedUuid,
  tenantRow,
  userRows,
} from './plan.js';

const NOW = '2026-10-20T12:00:00.000Z' as IsoTimestamp;
const tenantId = newId();
const userIds = Object.fromEntries(PERSONA_KEYS.map((k) => [k, newId()])) as Record<
  PersonaKey,
  Uuid
>;
const build = (over: Partial<Parameters<typeof buildTenantSeedPlan>[0]> = {}) =>
  buildTenantSeedPlan({
    now: NOW,
    tenantId,
    userIds,
    juiceShopUrl: 'http://juice-shop:3000',
    ...over,
  });

describe('seedUuid', () => {
  it('is a deterministic UUIDv7 per key (idempotent re-seeds target the same rows)', () => {
    expect(seedUuid('a')).toBe(seedUuid('a'));
    expect(seedUuid('a')).not.toBe(seedUuid('b'));
    for (const k of ['a', 'b', 'tenant:acme', 'x'.repeat(200)])
      expect(isUuidV7(seedUuid(k))).toBe(true);
  });

  it('builds the same plan twice (same ids, same rows apart from the fresh dev signature)', () => {
    const a = build();
    const b = build();
    expect(b.asset).toEqual(a.asset);
    expect(b.credentials).toEqual(a.credentials);
    expect(b.roleMatrix).toEqual(a.roleMatrix);
    expect(b.standingAuthorisation.id).toBe(a.standingAuthorisation.id);
    expect(tenantRow(NOW)).toEqual(tenantRow(NOW));
  });
});

describe('platform rows', () => {
  it('creates tenant acme active with region and plan', () => {
    expect(tenantRow(NOW)).toMatchObject({
      slug: 'acme',
      status: 'active',
      region: 'eu-west-1',
      plan: 'dev',
    });
  });

  it('creates one user per persona and keeps a pending subject when Keycloak did not confirm it', () => {
    const rows = userRows(NOW, { appsec: 'kc-sub-1' });
    expect(rows.map((r) => r.persona)).toEqual([...PERSONA_KEYS]);
    expect(rows.find((r) => r.persona === 'appsec')?.keycloakSub).toBe('kc-sub-1');
    expect(rows.find((r) => r.persona === 'owner')?.keycloakSub).toBe('pending:owner@acme.test');
  });
});

describe('buildTenantSeedPlan', () => {
  it('gives every persona except the platform operator a membership with its roles', () => {
    const plan = build();
    expect(plan.memberships).toHaveLength(5);
    expect(plan.memberships.some((m) => m.userId === userIds.operator)).toBe(false);
    const owner = SEED_PERSONAS.find((p) => p.key === 'owner');
    expect(plan.memberships.find((m) => m.userId === userIds.owner)?.roles).toEqual(owner?.roles);
  });

  it('seeds a verified (targetable, §8.10) web_app asset at the lab Juice Shop service name', () => {
    const { asset } = build();
    expect(asset).toMatchObject({
      type: 'web_app',
      identifiers: [{ kind: 'url', value: 'http://juice-shop:3000' }],
      environment: 'dev',
      ownerUserId: userIds.owner,
      verificationStatus: 'verified',
      verificationMethod: 'manual_letter',
    });
    expect(asset.attestation).toMatchObject({ lockoutExemption: true });
  });

  it('seeds an active, unexpired SA (relative to now) with requester != approver and a dev signature', () => {
    const { standingAuthorisation: sa, asset } = build();
    expect(sa.status).toBe('active');
    expect(sa.maxIntrusiveness).toBe('active_safe');
    expect(sa.assetIds).toEqual([asset.id]);
    expect(sa.requesterId).not.toBe(sa.approverId);
    expect(sa.validFrom).toBe(NOW);
    expect(fromIso(sa.expiresAt).getTime()).toBeGreaterThan(fromIso(NOW).getTime());
    expect(sa.signature.split('.')).toHaveLength(3);
    expect(sa.signingKeyId).toMatch(/^dev-seed-[0-9a-f]{16}$/);
  });

  it('computes expiry from the injected clock, so a later seed never writes an already-expired SA', () => {
    const later = '2031-01-01T00:00:00.000Z' as IsoTimestamp;
    const sa = build({ now: later }).standingAuthorisation;
    expect(fromIso(sa.expiresAt).getTime()).toBeGreaterThan(fromIso(later).getTime());
  });

  it('keeps the SA window and its test window in UTC across a DST switch', () => {
    // EU clocks change at 2026-03-29T01:00Z. A seed run just before that must still expire exactly 90 days later.
    const beforeSwitch = '2026-03-28T23:30:00.000Z' as IsoTimestamp;
    const { standingAuthorisation: sa } = build({ now: beforeSwitch });
    expect(sa.expiresAt).toBe('2026-06-26T23:30:00.000Z');
    expect(sa.testWindows).toEqual([
      { cron: '0 0 * * *', timezone: 'UTC', durationMs: 86_400_000 },
    ]);
  });

  it('rejects requester == approver (§8.4)', () => {
    const err = (() => {
      try {
        build({ requester: 'owner', approver: 'owner' });
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(isAppError(err) && err.code).toBe('VALIDATION_FAILED');
    expect(() => {
      assertSeparationOfDuties('a', 'a');
    }).toThrow(/approver must not be the requester/);
    expect(() => {
      assertSeparationOfDuties('a', 'b');
    }).not.toThrow();
  });

  it('stores credentials for at least two roles as OpenBao references only', () => {
    const { credentials } = build();
    expect(credentials.length).toBeGreaterThanOrEqual(2);
    for (const c of credentials) {
      expect(c.secretRef).toMatch(/^openbao:\/\/secret\/data\/tenants\/acme\//);
      expect(JSON.stringify(c)).not.toMatch(/password"\s*:\s*"[^"]*[^d"]"|admin123/);
    }
  });

  it('builds a role matrix covering every role for every function', () => {
    const { roleMatrix } = build();
    for (const row of roleMatrix.matrix.functions)
      expect(Object.keys(row.expected).sort()).toEqual([...roleMatrix.matrix.roles].sort());
  });

  it('rejects a Juice Shop URL with credentials or a bad scheme', () => {
    expect(() => build({ juiceShopUrl: 'http://u:p@127.0.0.1:13000' })).toThrow(
      /without credentials/,
    );
    expect(() => build({ juiceShopUrl: 'ftp://127.0.0.1' })).toThrow();
    expect(() => build({ juiceShopUrl: 'nope' })).toThrow(/not a valid URL/);
  });
});

describe('assertSecretRef (plaintext secret slip)', () => {
  it.each([
    'admin123',
    'password=hunter2',
    'postgres://user:pw@host/db',
    'openbao://secret/data/platform/x',
    'openbao://secret/data/tenants/acme',
    'eyJhbGciOiJIUzI1NiJ9.e30.sig',
    '',
  ])('rejects %j', (value) => {
    expect(() => {
      assertSecretRef(value);
    }).toThrow(/never a credential/);
  });

  it('accepts a tenant-scoped OpenBao reference', () => {
    expect(() => {
      assertSecretRef('openbao://secret/data/tenants/acme/assets/juice-shop/credentials/admin');
    }).not.toThrow();
  });
});

describe('devSign', () => {
  it('signs with a fresh key each run (never a committed key)', () => {
    expect(devSign({ a: 1 }).signingKeyId).not.toBe(devSign({ a: 1 }).signingKeyId);
  });
});

describe('seed env', () => {
  const base = {
    DATABASE_URL: 'postgres://bw_app:${PW}@127.0.0.1:15432/blackwing',
    MIGRATION_DATABASE_URL: 'postgres://bw_migrator:x@127.0.0.1:15432/blackwing',
    PW: 'p',
  };

  it('expands ${VAR} references and defaults the Juice Shop URL', () => {
    const env = seedEnvSchema.parse(expandEnv({ ...base, NODE_ENV: 'development' }));
    expect(String(env.DATABASE_URL)).toContain('bw_app:p@');
    expect(env.BW_TARGET_JUICE_SHOP_URL).toBe('http://127.0.0.1:13000');
  });

  it('refuses to seed staging or production', () => {
    for (const NODE_ENV of ['production', 'staging']) {
      expect(seedEnvSchema.safeParse(expandEnv({ ...base, NODE_ENV })).success).toBe(false);
    }
  });

  /** The error `assertSeedAllowed` throws for `nodeEnv`, or undefined when the seed is allowed. */
  const refusal = (nodeEnv: string | undefined): unknown => {
    try {
      assertSeedAllowed(nodeEnv);
      return undefined;
    } catch (error) {
      return error;
    }
  };

  it('allows development and test only', () => {
    expect(refusal('development')).toBeUndefined();
    expect(refusal('test')).toBeUndefined();
  });

  it('refuses production, staging and an unset NODE_ENV with SEED_FORBIDDEN_IN_PROD, before any config is read', () => {
    for (const nodeEnv of ['production', 'staging', undefined]) {
      const error = refusal(nodeEnv);
      expect(error).toBeInstanceOf(SeedForbiddenInProdError);
      expect(isAppError(error) && error.code).toBe('SEED_FORBIDDEN_IN_PROD');
    }
  });
});

describe('lookupSubjects (Keycloak users absent)', () => {
  const opts = {
    baseUrl: 'http://kc.invalid',
    realm: 'blackwing-dev',
    adminUser: 'a',
    adminPassword: 'kc-admin-pw-sentinel',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('resolves subjects and reports personas missing from the realm', async () => {
    const fake: typeof fetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/token')) return Promise.resolve(json({ access_token: 't' }));
      const username = new URL(url).searchParams.get('username') ?? '';
      return Promise.resolve(
        json(username === 'dev@acme.test' ? [] : [{ id: `sub-${username}`, username }]),
      );
    };
    const result = await lookupSubjects({ ...opts, fetch: fake });
    expect(result.missing).toEqual(['dev']);
    expect(result.subjects.appsec).toBe('sub-appsec@acme.test');
    expect(result.unavailable).toBeUndefined();
  });

  it('never throws when Keycloak is unreachable or refuses the admin login', async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const refused: typeof fetch = () => Promise.resolve(json({}, 401));
    for (const fake of [down, refused]) {
      const result = await lookupSubjects({ ...opts, fetch: fake });
      expect(result.missing).toEqual([...PERSONA_KEYS]);
      expect(result.unavailable).toBeDefined();
      expect(result.unavailable).not.toContain('kc-admin-pw-sentinel');
    }
  });
});

describe('private-range lab gate (#880)', () => {
  const cidrRules = (plan: ReturnType<typeof build>) => plan.standingAuthorisation.scopeRules.rules;

  it('seeds the compose service name, never localhost, and the dev lab cidr rule', () => {
    const plan = build();
    expect(plan.asset.identifiers).toEqual([{ kind: 'url', value: 'http://juice-shop:3000' }]);
    const lab = cidrRules(plan).find((r) => r.effect === 'include' && r.cidr === SEED_LAB_CIDR);
    expect(lab?.ports).toEqual([3000]);
    expect(plan.labScope).toEqual({ privateRuleCount: 1, labNetworks: [SEED_LAB_CIDR] });
  });

  it('keeps the admin path excluded and the host rule for the service name', () => {
    const rules = cidrRules(build());
    expect(rules).toContainEqual({ effect: 'include', host: 'juice-shop', ports: [3000] });
    expect(rules).toContainEqual({
      effect: 'exclude',
      host: 'juice-shop',
      paths: ['/rest/admin/application-version'],
    });
  });

  it('refuses a localhost target, since loopback is never in scope', () => {
    expect(() => build({ juiceShopUrl: 'http://127.0.0.1:13000' })).toThrow(/never in scope/);
    expect(() => build({ juiceShopUrl: 'http://localhost:13000' })).not.toThrow();
  });

  it('refuses the lab cidr outside dev and test, and for a public lab network', () => {
    expect(() => build({ labEnv: 'production' })).toThrow(/BW_ENV dev or test/);
    expect(() => build({ labEnv: 'staging' })).toThrow(/BW_ENV dev or test/);
    expect(() => build({ labCidr: '93.184.216.0/24' })).toThrow(/not a private range/);
  });

  it('admits the test environment as well', () => {
    expect(build({ labEnv: 'test' }).labScope.privateRuleCount).toBe(1);
  });
});
