import { describe, expect, it } from 'vitest';

import { createOpenBaoBackend } from './openbao.js';

import type { OpenBaoResponse } from '../openbao.js';
import type { TransitClient } from '../transit.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const DEK = new Uint8Array(32).fill(9);

/** In-memory Transit: ciphertext is bound to its key name, so another tenant's key cannot decrypt it. */
class FakeTransit implements TransitClient {
  down = false;
  encrypt(key: string, plaintextB64: string): Promise<string> {
    if (this.down) return Promise.reject(new Error('sealed'));
    return Promise.resolve(`vault:v1:${Buffer.from(`${key}|${plaintextB64}`).toString('base64')}`);
  }
  decrypt(key: string, ciphertext: string): Promise<string> {
    if (this.down) return Promise.reject(new Error('sealed'));
    const body = Buffer.from(ciphertext.slice('vault:v1:'.length), 'base64').toString('utf8');
    const [owner, b64 = ''] = body.split('|');
    if (owner !== key) return Promise.reject(new Error('decryption failed'));
    return Promise.resolve(b64);
  }
  async rewrap(key: string, ciphertext: string): Promise<string> {
    return this.encrypt(key, await this.decrypt(key, ciphertext));
  }
}

async function codeOfAsync(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

function setup(options: { disabled?: string[]; health?: OpenBaoResponse | Error } = {}) {
  const transit = new FakeTransit();
  const disabled = new Set(options.disabled ?? []);
  const kek = { isTenantKekDisabled: (t: string) => Promise.resolve(disabled.has(t)) };
  const client = {
    request: () => {
      const h = options.health;
      if (h instanceof Error) return Promise.reject(h);
      return Promise.resolve(h ?? { status: 200, data: undefined });
    },
  };
  const metrics: string[] = [];
  const backend = createOpenBaoBackend({
    transit,
    client,
    kek,
    telemetry: { metrics: { record: (k, op, r) => metrics.push(`${k}/${op}/${r}`) } },
  });
  return { backend, transit, metrics };
}

describe('createOpenBaoBackend (kek_wrap, the default)', () => {
  it('is the kek_wrap backend of kind openbao', () => {
    const { backend } = setup();
    expect(backend.kind).toBe('openbao');
    expect(backend.mode).toBe('kek_wrap');
  });

  it('wraps and unwraps a DEK under the tenant key, round-tripping exactly', async () => {
    const { backend, metrics } = setup();
    const wrapped = await backend.wrapDek(TENANT_A, DEK);
    expect(wrapped.startsWith('vault:v1:')).toBe(true);
    expect(Buffer.from(await backend.unwrapDek(TENANT_A, wrapped))).toEqual(Buffer.from(DEK));
    expect(metrics).toEqual(['openbao/wrap/ok', 'openbao/unwrap/ok']);
  });

  it('cannot unwrap a DEK wrapped for another tenant', async () => {
    const { backend } = setup();
    const wrapped = await backend.wrapDek(TENANT_A, DEK);
    await expect(backend.unwrapDek(TENANT_B, wrapped)).rejects.toThrow('decryption failed');
  });

  it('refuses every wrap and unwrap for a disabled tenant KEK (fail closed, no encrypt)', async () => {
    const { backend, transit } = setup({ disabled: [TENANT_A] });
    const encrypt = transit.encrypt.bind(transit);
    let encrypted = 0;
    transit.encrypt = (k, p) => {
      encrypted += 1;
      return encrypt(k, p);
    };
    expect(await codeOfAsync(backend.wrapDek(TENANT_A, DEK))).toBe('KEK_DISABLED');
    expect(await codeOfAsync(backend.unwrapDek(TENANT_A, 'vault:v1:AAAA'))).toBe('KEK_DISABLED');
    expect(encrypted).toBe(0);
  });

  it('rejects a DEK that is not 32 bytes', async () => {
    const { backend } = setup();
    expect(await codeOfAsync(backend.wrapDek(TENANT_A, new Uint8Array(16)))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('rejects a wrapped value that is not Transit ciphertext', async () => {
    const { backend } = setup();
    expect(await codeOfAsync(backend.unwrapDek(TENANT_A, 'plain-dek-bytes'))).toBe(
      'ENVELOPE_INVALID',
    );
  });

  it('rejects an invalid tenant id before any Transit call', async () => {
    const { backend, transit } = setup();
    let calls = 0;
    transit.encrypt = () => {
      calls += 1;
      return Promise.resolve('vault:v1:AAAA');
    };
    await expect(backend.wrapDek('../x', DEK)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(calls).toBe(0);
  });

  it('reports healthy only on sys/health 200 and surfaces misconfiguration in testAccess', async () => {
    expect((await setup().backend.health()).healthy).toBe(true);
    const sealed = setup({ health: { status: 503, data: undefined } }).backend;
    expect((await sealed.health()).healthy).toBe(false);
    await expect(sealed.testAccess()).rejects.toMatchObject({ code: 'KEK_UNAVAILABLE' });
    const unreachable = setup({ health: new Error('ECONNREFUSED') }).backend;
    expect((await unreachable.health()).healthy).toBe(false);
  });

  it('takes no per-tenant config, so any extra field is refused', () => {
    const { backend } = setup();
    expect(() => {
      backend.validate({});
    }).not.toThrow();
    expect(() => {
      backend.validate({ token: 'plaintext' });
    }).toThrow();
  });
});
