// Asset login credentials against real Postgres (#363): the four credential routes end to end through the NestJS app,
// with the tenant guard, RBAC plus Cedar, RLS, the Secrets Service seam (a recording fake vault here), the audit chain
// and the no-secret-leak rules: no response, no log line and no table row carries a secret value in plaintext.
// Needs Docker (Testcontainers); run with `pnpm --filter @blackwing/api test:int`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDatabase, memberships, migrateDatabase, tenants, withTenant } from '@blackwing/db';
import { newId } from '@blackwing/ids';
import { createLogger, type Logger } from '@blackwing/logger';
import { type PostgresHandle, withPostgres } from '@blackwing/testing/containers';

import { createApiApp, type ApiApp } from '../bootstrap/create-app.js';
import { createHttpMetrics } from '../bootstrap/metrics.js';
import { loadApiConfig } from '../config.js';
import { AssetsModule } from './module.js';
import { createQuotaMetrics } from '../quota/metrics.js';
import { QuotaService } from '../quota/service.js';

import type { CredentialVault } from './credential-vault.js';
import type { TenantPrincipal } from '@blackwing/db/tenant-context';
import type { Envelope } from '@blackwing/secrets';

let handle: PostgresHandle;
let app: ApiApp;

/** A recording stand-in for the Secrets Service. `down` makes every write fail, as a sealed OpenBao would. */
const sealed: { tenantId: string; secretId: string; plaintext: string }[] = [];
const rotated: { tenantId: string; secretId: string; plaintext: string }[] = [];
let vaultMode: 'ok' | 'down' = 'ok';
let nextRotationVersion = 2;
const vault: CredentialVault = {
  seal(input) {
    if (vaultMode === 'down') return Promise.reject(new Error('openbao sealed'));
    sealed.push(input);
    return Promise.resolve(fakeEnvelope(input.secretId));
  },
  rotate(input) {
    if (vaultMode === 'down') return Promise.reject(new Error('openbao sealed'));
    rotated.push(input);
    return Promise.resolve(nextRotationVersion);
  },
};

/** An envelope whose ciphertext is derived from the secret id only: it never contains a plaintext value. */
function fakeEnvelope(secretId: string): Envelope {
  return {
    v: 1,
    alg: 'AES-256-GCM',
    kekKey: 'tenant-test',
    kekVersion: 1,
    wrappedDek: 'vault:v1:test',
    iv: 'AAAAAAAAAAAAAAAA',
    tag: 'AAAAAAAAAAAAAAAAAAAAAA==',
    ct: Buffer.from(`ciphertext-of-${secretId}`).toString('base64'),
    aadHash: 'aa'.repeat(32),
  };
}

const tenantA = newId();
const tenantB = newId();
const alice = newId(); // appsec_engineer in A: may manage credentials
const carol = newId(); // auditor in A: read only
const eve = newId(); // appsec_engineer in B
const mallory = newId(); // not a member anywhere

interface Caller {
  readonly tenant: string;
  readonly user: string;
}
const as = (caller: Caller) => ({ 'x-test-caller': `${caller.tenant}|${caller.user}` });
const ALICE: Caller = { tenant: tenantA, user: alice };
const CAROL: Caller = { tenant: tenantA, user: carol };
const EVE: Caller = { tenant: tenantB, user: eve };
const MALLORY: Caller = { tenant: tenantA, user: mallory };

const db = () => createDatabase(handle.appPool);

/** Distinctive plaintext values: every leak check looks for these exact strings. */
const PASSWORD = 'pw-DO-NOT-LEAK-7f3a9c';
const TOKEN = 'tok-DO-NOT-LEAK-2b8e1d';
const TOTP_SEED = 'JBSWY3DPEHPK3PXPSEED-DO-NOT-LEAK';

const formRecipe = {
  type: 'form',
  loginUrl: 'https://portal.example.com/login',
  usernameField: 'input[name=user]',
  passwordField: 'input[name=pass]',
  submitSelector: 'button[type=submit]',
  successCheck: '.dashboard',
};

const credentialBody = (overrides: Record<string, unknown> = {}) => ({
  roleName: 'admin',
  loginRecipe: formRecipe,
  mfaType: 'none',
  secrets: { username: 'admin@portal', password: PASSWORD },
  ...overrides,
});

const body = (overrides: Record<string, unknown> = {}) => ({
  type: 'web_app',
  name: 'Customer portal',
  identifiers: [{ kind: 'url', value: 'https://portal.example.com' }],
  environment: 'staging',
  ownerUserId: alice,
  ...overrides,
});

/** Every line the logger wrote, as text, so a leak check can search the whole output. */
const logLines: string[] = [];
function capturingLogger(): Logger {
  const base = createLogger('api', { level: 'silent', nodeEnv: 'test' });
  const sink = {
    info: (obj: unknown, msg?: string) => logLines.push(`${JSON.stringify(obj)} ${msg ?? ''}`),
    warn: (obj: unknown, msg?: string) => logLines.push(`${JSON.stringify(obj)} ${msg ?? ''}`),
  };
  return Object.assign(Object.create(base) as Logger, sink);
}

async function call(
  caller: Caller | undefined,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) {
  return app.app.inject({
    method,
    url,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(caller === undefined ? {} : as(caller)),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function createAsset(): Promise<string> {
  const res = await call(ALICE, 'POST', '/v1/assets', body());
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

/** Reads rows as the app role with the tenant set for the transaction (RLS enforced). */
async function queryAs<T>(tenant: string, text: string, values: unknown[] = []): Promise<T[]> {
  const client = await handle.appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await client.query(text, values);
    await client.query('COMMIT');
    return result.rows as T[];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedUser(id: string): Promise<void> {
  await handle.ownerPool.query(
    'INSERT INTO users (id, keycloak_sub, email, name) VALUES ($1, $2, $3, $4)',
    [id, `sub-${id}`, `${id}@test.invalid`, 'test user'],
  );
}

async function seedMember(tenantId: string, userId: string, roles: string[]): Promise<void> {
  await withTenant(db(), tenantId, (tx) =>
    tx.insert(memberships).values({ tenantId, userId, roles }),
  );
}

function principalOf(headers: Record<string, unknown>): TenantPrincipal | null {
  const raw = headers['x-test-caller'];
  if (typeof raw !== 'string') return null;
  const [tenant, user] = raw.split('|');
  if (tenant === undefined || user === undefined) return null;
  return { actor: { type: 'user', id: user }, sessionTenantId: tenant };
}

beforeAll(async () => {
  handle = await withPostgres({ migrations: (owner) => migrateDatabase(owner) });
  await withTenant(db(), tenantA, (tx) =>
    tx
      .insert(tenants)
            // Enterprise is unlimited: the plan quota (TENANT-009) has its own suite; these routes are not under test there.
      .values({
        id: tenantA,
        slug: 'acme-creds',
        name: 'Acme',
        region: 'eu-west-1',
        plan: 'enterprise',
      }),
  );
  await withTenant(db(), tenantB, (tx) =>
    tx
      .insert(tenants)
      .values({ id: tenantB, slug: 'beta-creds', name: 'Beta', region: 'eu-west-1' }),
  );
  for (const user of [alice, carol, eve, mallory]) await seedUser(user);
  await seedMember(tenantA, alice, ['appsec_engineer']);
  await seedMember(tenantA, carol, ['auditor']);
  await seedMember(tenantB, eve, ['appsec_engineer']);

  const config = loadApiConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:3000',
    RATE_LIMIT_DEFAULT_RPS: '1000',
    RATE_LIMIT_BURST: '100000',
  });
  const metrics = createHttpMetrics();
  app = await createApiApp({
    config,
    logger: capturingLogger(),
    metrics,
    tenantPrincipalSource: (request) => principalOf(request.headers),
    imports: [
      AssetsModule.forRoot({
        database: db(),
        registry: metrics.registry,
        verificationProbes: [],
        quota: new QuotaService({
          database: db(),
          metrics: createQuotaMetrics(metrics.registry),
          logger: capturingLogger(),
        }),
        credentialVault: vault,
      }),
    ],
  });
  await app.app.getHttpAdapter().getInstance().ready();
});

beforeEach(() => {
  vaultMode = 'ok';
  nextRotationVersion = 2;
  sealed.length = 0;
  rotated.length = 0;
  logLines.length = 0;
});

afterAll(async () => {
  await app.app.close();
  await handle.stop();
});

/** Every response and log line of a call must be free of the given plaintext values. */
function expectNoLeak(text: string): void {
  for (const value of [PASSWORD, TOKEN, TOTP_SEED]) expect(text).not.toContain(value);
}

describe('POST /v1/assets/:id/credentials', () => {
  it('stores the login by reference: 201, the recipe and secret_ref back, no secret echoed', async () => {
    const assetId = await createAsset();
    const res = await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    expect(res.statusCode).toBe(201);
    const view = res.json<Record<string, unknown>>();
    expect(view).toMatchObject({
      roleName: 'admin',
      loginRecipe: formRecipe,
      mfaType: 'none',
    });
    expect(String(view.secretRef)).toMatch(new RegExp(`^bw-secret://${tenantA}/[0-9a-f-]{36}$`));
    expect(res.headers.location).toBe(`/v1/assets/${assetId}/credentials/admin`);
    expect(res.headers['cache-control']).toBe('no-store');
    expectNoLeak(res.body);
    expect(res.body).not.toContain('admin@portal');
  });

  it('sends the secrets to the vault once, under the tenant and the new secret id', async () => {
    const assetId = await createAsset();
    const res = await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    expect(res.statusCode).toBe(201);
    expect(sealed).toHaveLength(1);
    const [seal] = sealed;
    expect(seal?.tenantId).toBe(tenantA);
    expect(JSON.parse(seal?.plaintext ?? '{}')).toEqual({
      username: 'admin@portal',
      password: PASSWORD,
    });
    expect(res.json<{ secretRef: string }>().secretRef.endsWith(seal?.secretId ?? '')).toBe(true);
  });

  it('persists only the reference, the recipe, the MFA type and the envelope: no plaintext anywhere', async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    const [row] = await queryAs<Record<string, unknown>>(
      tenantA,
      'SELECT role_name, secret_ref, login_recipe, mfa_type FROM asset_credentials WHERE asset_id = $1',
      [assetId],
    );
    expect(row).toMatchObject({ role_name: 'admin', mfa_type: 'none' });
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    const [secret] = await queryAs<Record<string, unknown>>(
      tenantA,
      'SELECT envelope, purpose FROM secrets WHERE id::text = $1',
      [String(row?.secret_ref).split('/').at(-1)],
    );
    expect(secret?.purpose).toBe('asset_login');
    expect(JSON.stringify(secret)).not.toContain(PASSWORD);
    expect(JSON.stringify(secret)).not.toContain('admin@portal');
  });

  it('records asset.credential_added in the audit chain, without secret material', async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    const events = await queryAs<{ action: string; metadata: Record<string, unknown> }>(
      tenantA,
      "SELECT action, metadata FROM audit_events WHERE action = 'asset.credential_added' AND target->>'id' = (SELECT id::text FROM assets WHERE id = $1)",
      [assetId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ roleName: 'admin', mfaType: 'none' });
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
  });

  it('writes nothing to the log lines beyond ids and the secret reference: no secret value anywhere', async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    const lines = logLines.filter((line) => line.includes('asset.credential_added'));
    expect(lines).toHaveLength(1);
    expectNoLeak(logLines.join('\n'));
  });

  it('refuses a duplicate role with 409 and stores no second secret', async () => {
    const assetId = await createAsset();
    expect(
      (await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody())).statusCode,
    ).toBe(201);
    const loginSecrets = (): Promise<unknown[]> =>
      queryAs(tenantA, 'SELECT id FROM secrets WHERE purpose = $1', ['asset_login']);
    const secretsBefore = await loginSecrets();
    const second = await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    expect(second.statusCode).toBe(409);
    expect(second.json<{ code: string }>().code).toBe('asset_cred_duplicate_role');
    expectNoLeak(second.body);
    const rows = await queryAs(tenantA, 'SELECT id FROM asset_credentials WHERE asset_id = $1', [
      assetId,
    ]);
    expect(rows).toHaveLength(1);
    // Other tests share this database, so the check is the delta: the refused create wrote no secret record.
    expect(await loginSecrets()).toHaveLength(secretsBefore.length);
  });

  it('answers 503 and persists nothing when the Secrets Service is down (no partial row)', async () => {
    const assetId = await createAsset();
    vaultMode = 'down';
    const res = await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('asset_cred_secret_write_failed');
    expectNoLeak(res.body);
    const rows = await queryAs(tenantA, 'SELECT id FROM asset_credentials WHERE asset_id = $1', [
      assetId,
    ]);
    expect(rows).toHaveLength(0);
    expect(logLines.join('\n')).toContain('asset.credential_secret_write_failed');
  });

  it('refuses a recipe over the size cap with 413 before anything else is checked', async () => {
    const assetId = await createAsset();
    const huge = { ...formRecipe, loginUrl: `https://portal.example.com/${'a'.repeat(70_000)}` };
    const res = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({ loginRecipe: huge }),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json<{ code: string }>().code).toBe('asset_cred_recipe_too_large');
    expect(sealed).toHaveLength(0);
  });

  it('refuses a recipe that is missing a field its type needs (422), naming the field, not the value', async () => {
    const assetId = await createAsset();
    const incomplete = { ...formRecipe, successCheck: undefined };
    const res = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({ loginRecipe: incomplete }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('validation_failed');
    expect(res.body).toContain('successCheck');
    expectNoLeak(res.body);
  });

  it('refuses a login URL that embeds credentials, without echoing them (422)', async () => {
    const assetId = await createAsset();
    const res = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({
        loginRecipe: {
          ...formRecipe,
          loginUrl: `https://svc:${PASSWORD}@portal.example.com/login`,
        },
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(PASSWORD);
  });

  it('refuses a non-HTTP login URL and an unknown recipe type (422)', async () => {
    const assetId = await createAsset();
    const scheme = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({ loginRecipe: { ...formRecipe, loginUrl: 'file:///etc/passwd' } }),
    );
    expect(scheme.statusCode).toBe(422);
    const unknownType = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({ roleName: 'other', loginRecipe: { type: 'telnet' } }),
    );
    expect(unknownType.statusCode).toBe(422);
  });

  it('requires the secrets a recipe needs: a password for form, a token for bearer, a seed for TOTP', async () => {
    const assetId = await createAsset();
    const noPassword = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({ secrets: { username: 'admin@portal' } }),
    );
    expect(noPassword.statusCode).toBe(422);
    expect(noPassword.body).toContain('secrets.password');

    const noToken = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({
        roleName: 'api',
        loginRecipe: { type: 'bearer_header', headerName: 'Authorization' },
        secrets: {},
      }),
    );
    expect(noToken.statusCode).toBe(422);
    expect(noToken.body).toContain('secrets.token');

    const noSeed = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({ roleName: 'mfa', mfaType: 'totp' }),
    );
    expect(noSeed.statusCode).toBe(422);
    expect(noSeed.body).toContain('secrets.totpSeed');
    expect(sealed).toHaveLength(0);
  });

  it('refuses an unknown MFA type and an unknown field in the body (422)', async () => {
    const assetId = await createAsset();
    const badMfa = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({ mfaType: 'carrier-pigeon' }),
    );
    expect(badMfa.statusCode).toBe(422);
    const extra = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({ tenantId: tenantB }),
    );
    expect(extra.statusCode).toBe(422);
  });

  it('accepts a bearer header login with a TOTP seed, storing both in one secret', async () => {
    const assetId = await createAsset();
    const res = await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({
        roleName: 'svc',
        loginRecipe: { type: 'bearer_header', headerName: 'X-Api-Token' },
        mfaType: 'totp',
        secrets: { token: TOKEN, totpSeed: TOTP_SEED },
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.json<{ loginRecipe: unknown }>().loginRecipe).toEqual({
      type: 'bearer_header',
      headerName: 'x-api-token',
    });
    expectNoLeak(res.body);
    expect(JSON.parse(sealed[0]?.plaintext ?? '{}')).toEqual({ token: TOKEN, totpSeed: TOTP_SEED });
  });

  it('is refused for a caller without the permission (403) and for a non-member (403)', async () => {
    const assetId = await createAsset();
    const auditor = await call(
      CAROL,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody(),
    );
    expect(auditor.statusCode).toBe(403);
    const outsider = await call(
      MALLORY,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody(),
    );
    expect(outsider.statusCode).toBe(403);
    expect(sealed).toHaveLength(0);
  });

  it("answers 404 for another tenant's asset and for an unknown asset", async () => {
    const assetId = await createAsset();
    const cross = await call(EVE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    expect(cross.statusCode).toBe(404);
    const unknown = await call(
      ALICE,
      'POST',
      `/v1/assets/${newId()}/credentials`,
      credentialBody(),
    );
    expect(unknown.statusCode).toBe(404);
    expect(sealed).toHaveLength(0);
  });
});

describe('GET /v1/assets/:id/credentials', () => {
  it('lists the recipe and reference of every role, never a secret', async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    await call(
      ALICE,
      'POST',
      `/v1/assets/${assetId}/credentials`,
      credentialBody({ roleName: 'viewer' }),
    );
    const res = await call(CAROL, 'GET', `/v1/assets/${assetId}/credentials`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const items = res.json<{ items: { roleName: string; secretRef: string }[] }>().items;
    expect(items.map((item) => item.roleName)).toEqual(['admin', 'viewer']);
    expectNoLeak(res.body);
  });

  it('reads one role by name, and answers 404 for an unknown role', async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    const one = await call(ALICE, 'GET', `/v1/assets/${assetId}/credentials/admin`);
    expect(one.statusCode).toBe(200);
    expect(one.json<{ roleName: string }>().roleName).toBe('admin');
    expectNoLeak(one.body);
    const missing = await call(ALICE, 'GET', `/v1/assets/${assetId}/credentials/nobody`);
    expect(missing.statusCode).toBe(404);
  });

  it("never shows one tenant its neighbour's credentials", async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    const list = await call(EVE, 'GET', `/v1/assets/${assetId}/credentials`);
    expect(list.statusCode).toBe(404);
    const one = await call(EVE, 'GET', `/v1/assets/${assetId}/credentials/admin`);
    expect(one.statusCode).toBe(404);
    const outsider = await call(MALLORY, 'GET', `/v1/assets/${assetId}/credentials`);
    expect(outsider.statusCode).toBe(403);
  });
});

describe('POST /v1/assets/:id/credentials/:role/rotate', () => {
  it('replaces the secret through the vault, bumps the version and audits the rotation', async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    const res = await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials/admin/rotate`, {
      secrets: { username: 'admin@portal', password: `${PASSWORD}-2` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>()).toMatchObject({
      roleName: 'admin',
      secretVersion: 2,
    });
    expect(res.json<{ secretRef: string }>().secretRef).toMatch(/^bw-secret:\/\//);
    expectNoLeak(res.body);
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.plaintext).toContain(`${PASSWORD}-2`);
    const events = await queryAs<{ action: string; metadata: Record<string, unknown> }>(
      tenantA,
      "SELECT action, metadata FROM audit_events WHERE action = 'asset.credential_rotated' AND target->>'id' = (SELECT id::text FROM assets WHERE id = $1)",
      [assetId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ roleName: 'admin', secretVersion: 2 });
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    expectNoLeak(logLines.join('\n'));
  });

  it('requires the secret set the stored recipe needs (422) and an unknown role is 404', async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    const incomplete = await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials/admin/rotate`, {
      secrets: { username: 'admin@portal' },
    });
    expect(incomplete.statusCode).toBe(422);
    const unknown = await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials/nobody/rotate`, {
      secrets: { username: 'x', password: 'y' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(rotated).toHaveLength(0);
  });

  it('answers 503 and leaves the credential unchanged when the vault is down', async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    const rotatedEvents = (): Promise<unknown[]> =>
      queryAs(tenantA, "SELECT id FROM audit_events WHERE action = 'asset.credential_rotated'");
    const eventsBefore = await rotatedEvents();
    vaultMode = 'down';
    const res = await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials/admin/rotate`, {
      secrets: { username: 'admin@portal', password: `${PASSWORD}-3` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('asset_cred_secret_write_failed');
    expectNoLeak(res.body);
    // Other tests share this database, so the check is the delta: the refused rotation audited nothing.
    expect(await rotatedEvents()).toHaveLength(eventsBefore.length);
  });

  it('is refused to a read-only auditor (403) and to another tenant (404)', async () => {
    const assetId = await createAsset();
    await call(ALICE, 'POST', `/v1/assets/${assetId}/credentials`, credentialBody());
    const auditor = await call(CAROL, 'POST', `/v1/assets/${assetId}/credentials/admin/rotate`, {
      secrets: { username: 'a', password: 'b' },
    });
    expect(auditor.statusCode).toBe(403);
    const cross = await call(EVE, 'POST', `/v1/assets/${assetId}/credentials/admin/rotate`, {
      secrets: { username: 'a', password: 'b' },
    });
    expect(cross.statusCode).toBe(404);
    expect(rotated).toHaveLength(0);
  });
});
