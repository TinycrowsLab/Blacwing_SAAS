import { describe, expect, it } from 'vitest';

import { type KekAuditEvent, createTenantKekService, kekKeyName } from './kek.js';
import { FakeOpenBao } from './test-support.js';

function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

function setup() {
  const bao = new FakeOpenBao();
  const events: KekAuditEvent[] = [];
  const results: string[] = [];
  const kek = createTenantKekService({
    client: bao,
    audit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
    metrics: {
      provision: (r) => results.push(`provision:${r}`),
      rotate: (r) => results.push(`rotate:${r}`),
    },
  });
  return { bao, events, results, kek };
}

describe('kekKeyName', () => {
  it('builds tenant-{id}', () => {
    expect(kekKeyName('ten_abc-1')).toBe('tenant-ten_abc-1');
  });

  it.each(['', '../x', 'a/b', 'a*', 'A', 'a b', '-a', 'a'.repeat(129), 'a?b', 'a\nb'])(
    'rejects %j',
    (id) => {
      expect(codeOf(() => kekKeyName(id))).toBe('VALIDATION_FAILED');
    },
  );

  it('rejects non-strings', () => {
    expect(() => kekKeyName(undefined as unknown as string)).toThrow();
  });
});

describe('ensureTenantKek', () => {
  it('creates a non-exportable aes256-gcm96 key, allows deletion, audits and counts', async () => {
    const { bao, events, results, kek } = setup();
    const info = await kek.ensureTenantKek('acme');
    expect(info).toMatchObject({ keyName: 'tenant-acme', latestVersion: 1, created: true });
    const create = bao.calls.find(
      (c) => c.method === 'POST' && c.path === 'transit/keys/tenant-acme',
    );
    expect(create?.body).toEqual({
      type: 'aes256-gcm96',
      exportable: false,
      allow_plaintext_backup: false,
    });
    expect(bao.keys.get('tenant-acme')).toMatchObject({
      deletion_allowed: true,
      exportable: false,
    });
    expect(events).toEqual([
      {
        tenantId: 'acme',
        action: 'secret.kek_provisioned',
        metadata: { keyName: 'tenant-acme', version: 1 },
      },
    ]);
    expect(results).toEqual(['provision:created']);
  });

  it('is an idempotent no-op the second time (no write, no audit)', async () => {
    const { bao, events, results, kek } = setup();
    await kek.ensureTenantKek('acme');
    bao.calls.length = 0;
    const again = await kek.ensureTenantKek('acme');
    expect(again.created).toBe(false);
    expect(bao.calls.filter((c) => c.method === 'POST')).toEqual([]);
    expect(events).toHaveLength(1);
    expect(results).toEqual(['provision:created', 'provision:exists']);
  });

  it('never adopts an exportable or wrongly typed existing key', async () => {
    const { bao, kek } = setup();
    bao.keys.set('tenant-acme', { type: 'aes256-gcm96', exportable: true, latest_version: 1 });
    await expect(kek.ensureTenantKek('acme')).rejects.toMatchObject({ code: 'INTERNAL' });
    bao.keys.set('tenant-b', { type: 'rsa-4096', exportable: false, latest_version: 1 });
    await expect(kek.ensureTenantKek('b')).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('fails closed when OpenBao is down: no key, no audit, error metric', async () => {
    const { bao, events, results, kek } = setup();
    bao.down = true;
    await expect(kek.ensureTenantKek('acme')).rejects.toThrow('sealed');
    expect(events).toEqual([]);
    expect(results).toEqual(['provision:error']);
  });

  it('rejects a foreign/invalid tenant id before any OpenBao call', async () => {
    const { bao, kek } = setup();
    await expect(kek.ensureTenantKek('acme/../tenant-b')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(bao.calls).toEqual([]);
  });

  it('fails the call when the audit sink rejects', async () => {
    const bao = new FakeOpenBao();
    const kek = createTenantKekService({
      client: bao,
      audit: () => Promise.reject(new Error('audit down')),
    });
    await expect(kek.ensureTenantKek('acme')).rejects.toThrow('audit down');
  });
});

describe('rotateTenantKek', () => {
  it('adds a version and keeps the minimum decrypt version', async () => {
    const { events, kek } = setup();
    await kek.ensureTenantKek('acme');
    const info = await kek.rotateTenantKek('acme');
    expect(info).toMatchObject({ latestVersion: 2, minDecryptionVersion: 1 });
    expect(events.at(-1)).toMatchObject({
      action: 'secret.kek_rotated',
      metadata: { keyName: 'tenant-acme', version: 2 },
    });
  });

  it('is NOT_FOUND for a tenant without a key', async () => {
    const { results, kek } = setup();
    await expect(kek.rotateTenantKek('acme')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(results).toEqual(['rotate:error']);
  });
});

describe('min decrypt version', () => {
  it('reads and raises it, rejecting lowering and values above latest', async () => {
    const { kek } = setup();
    await kek.ensureTenantKek('acme');
    await kek.rotateTenantKek('acme');
    await kek.rotateTenantKek('acme');
    expect(await kek.getKekMinVersion('acme')).toBe(1);
    expect(await kek.setKekMinDecryptVersion('acme', 2)).toMatchObject({ minDecryptionVersion: 2 });
    expect(await kek.getKekMinVersion('acme')).toBe(2);
    await expect(kek.setKekMinDecryptVersion('acme', 1)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(kek.setKekMinDecryptVersion('acme', 4)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(kek.setKekMinDecryptVersion('acme', 2.5)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('disableTenantKek', () => {
  it('marks the tenant, rotates, blocks every older version and audits', async () => {
    const { bao, events, kek } = setup();
    await kek.ensureTenantKek('acme');
    const info = await kek.disableTenantKek('acme');
    expect(info).toMatchObject({ latestVersion: 2, minDecryptionVersion: 2 });
    expect(bao.keys.get('tenant-acme')).toMatchObject({ min_decryption_version: 2 });
    expect(await kek.isTenantKekDisabled('acme')).toBe(true);
    expect(events.at(-1)).toMatchObject({ action: 'secret.kek_disabled' });
    // the marker is written before the rotation so nothing can land in the new version
    const order = bao.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('POST secret/data/platform/kek-state/acme')).toBeLessThan(
      order.indexOf('POST transit/keys/tenant-acme/rotate'),
    );
  });

  it('is idempotent once complete, and blocks ensure / rotate / min-version changes', async () => {
    const { bao, events, kek } = setup();
    await kek.ensureTenantKek('acme');
    await kek.disableTenantKek('acme');
    const count = events.length;
    await kek.disableTenantKek('acme');
    expect(events).toHaveLength(count);
    expect(bao.keys.get('tenant-acme')?.latest_version).toBe(2);
    await expect(kek.ensureTenantKek('acme')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(kek.rotateTenantKek('acme')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(kek.setKekMinDecryptVersion('acme', 2)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('resumes a half-finished disable', async () => {
    const { bao, kek } = setup();
    await kek.ensureTenantKek('acme');
    bao.kv.set('platform/kek-state/acme', { state: 'disabling', version: 1 });
    const info = await kek.disableTenantKek('acme');
    expect(info.minDecryptionVersion).toBe(info.latestVersion);
    expect(bao.kv.get('platform/kek-state/acme')).toMatchObject({ state: 'disabled' });
  });

  it('does not affect another tenant', async () => {
    const { kek } = setup();
    await kek.ensureTenantKek('acme');
    await kek.ensureTenantKek('globex');
    await kek.disableTenantKek('acme');
    expect(await kek.isTenantKekDisabled('globex')).toBe(false);
    await expect(kek.rotateTenantKek('globex')).resolves.toMatchObject({ latestVersion: 2 });
  });
});
