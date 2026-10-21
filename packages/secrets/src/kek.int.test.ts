// Per-tenant KEK lifecycle against a real OpenBao dev server (SECRETS-001): idempotent provisioning,
// non-exportable keys, least-privilege AppRole policies, rotation, disable and fail-closed. Needs
// Docker (Testcontainers); run with `pnpm --filter @blackwing/secrets test:int`.

import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type OpenBaoHandle, withOpenBao } from '@blackwing/testing/containers';

import { createTenantKekService, type KekAuditEvent, type TenantKekService } from './kek.js';
import { createOpenBaoClient, type OpenBaoClient } from './openbao.js';

let bao: OpenBaoHandle | undefined;
const handle = (): OpenBaoHandle => {
  if (bao === undefined) throw new Error('withOpenBao did not start');
  return bao;
};

async function root(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${handle().addr}/v1/${path}`, {
    method,
    headers: { 'x-vault-token': handle().rootToken, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

const policy = (name: string): string =>
  readFileSync(
    new URL(`../../../infra/compose/openbao/policies/${name}.hcl`, import.meta.url),
    'utf8',
  );

async function roleClient(role: string): Promise<OpenBaoClient> {
  await root('PUT', `sys/policies/acl/${role}`, { policy: policy(role) });
  await root('POST', `auth/approle/role/${role}`, { token_policies: [role] });
  const roleId = (
    (await root('GET', `auth/approle/role/${role}/role-id`)) as { data: { role_id: string } }
  ).data.role_id;
  const secretId = (
    (await root('POST', `auth/approle/role/${role}/secret-id`, {})) as {
      data: { secret_id: string };
    }
  ).data.secret_id;
  return createOpenBaoClient({ addr: handle().addr, roleId, secretId });
}

let app: OpenBaoClient;
let kek: TenantKekService;
const events: KekAuditEvent[] = [];

const b64 = (s: string): string => Buffer.from(s).toString('base64');
const encrypt = async (tenant: string, text: string): Promise<string> =>
  (await app.request('POST', `transit/encrypt/tenant-${tenant}`, { plaintext: b64(text) })).data
    ?.ciphertext as string;
const decrypt = (tenant: string, ciphertext: string) =>
  app.request('POST', `transit/decrypt/tenant-${tenant}`, { ciphertext });

beforeAll(async () => {
  bao = await withOpenBao();
  await root('POST', 'sys/auth/approle', { type: 'approle' });
  await root('POST', 'sys/mounts/transit', { type: 'transit' });
  app = await roleClient('bw-kek-app');
  const provisioner = await roleClient('bw-kek-provisioner');
  kek = createTenantKekService({
    client: provisioner,
    audit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
  });
});
afterAll(async () => {
  await bao?.stop();
});

describe('tenant KEK against OpenBao', () => {
  it('provisions a non-exportable key and is idempotent', async () => {
    const first = await kek.ensureTenantKek('t-one');
    const second = await kek.ensureTenantKek('t-one');
    expect([first.created, second.created]).toEqual([true, false]);
    const key = (await root('GET', 'transit/keys/tenant-t-one')) as {
      data: Record<string, unknown>;
    };
    expect(key.data).toMatchObject({
      type: 'aes256-gcm96',
      exportable: false,
      allow_plaintext_backup: false,
      deletion_allowed: true,
    });
    expect(events.filter((e) => e.tenantId === 't-one')).toHaveLength(1);
  });

  it('cannot export key material, not even as root (non-exportable) or as the app role (policy)', async () => {
    await expect(root('GET', 'transit/export/encryption-key/tenant-t-one')).rejects.toThrow();
    await expect(
      app.request('GET', 'transit/export/encryption-key/tenant-t-one'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(app.request('GET', 'transit/backup/tenant-t-one')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(app.request('GET', 'transit/keys/tenant-t-one')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('rotation adds a version and old ciphertext still decrypts', async () => {
    await kek.ensureTenantKek('t-rot');
    const ciphertext = await encrypt('t-rot', 'hello');
    expect(ciphertext).toMatch(/^vault:v1:/);
    const rotated = await kek.rotateTenantKek('t-rot');
    expect(rotated.latestVersion).toBe(2);
    const decrypted = await decrypt('t-rot', ciphertext);
    expect(Buffer.from(decrypted.data?.plaintext as string, 'base64').toString()).toBe('hello');
    expect(await encrypt('t-rot', 'x')).toMatch(/^vault:v2:/);
  });

  it('raising the min decrypt version blocks older versions only', async () => {
    await kek.ensureTenantKek('t-min');
    const old = await encrypt('t-min', 'old');
    await kek.rotateTenantKek('t-min');
    await kek.setKekMinDecryptVersion('t-min', 2);
    expect(await kek.getKekMinVersion('t-min')).toBe(2);
    await expect(decrypt('t-min', old)).rejects.toThrow();
  });

  it('disable blocks every subsequent decrypt and further provisioning', async () => {
    await kek.ensureTenantKek('t-dis');
    const ciphertext = await encrypt('t-dis', 'secret');
    await kek.disableTenantKek('t-dis');
    await expect(decrypt('t-dis', ciphertext)).rejects.toThrow();
    expect(await kek.isTenantKekDisabled('t-dis')).toBe(true);
    await expect(kek.ensureTenantKek('t-dis')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await kek.isTenantKekDisabled('t-one')).toBe(false);
  });

  it('the app role cannot use or touch another path than tenant-* keys', async () => {
    await expect(
      app.request('POST', 'transit/encrypt/other-key', { plaintext: b64('x') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails closed with KEK_UNAVAILABLE when OpenBao is unreachable', async () => {
    const dead = createOpenBaoClient(
      { addr: 'http://127.0.0.1:1', roleId: 'r', secretId: 's' },
      { sleep: () => Promise.resolve(), loginAttempts: 2 },
    );
    const down = createTenantKekService({ client: dead, audit: () => Promise.resolve() });
    await expect(down.ensureTenantKek('t-one')).rejects.toMatchObject({ code: 'KEK_UNAVAILABLE' });
  });
});
