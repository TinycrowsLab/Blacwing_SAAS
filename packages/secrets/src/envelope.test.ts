import { randomUUID } from 'node:crypto';

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEnvelopeCrypto,
  type Envelope,
  EnvelopeError,
  type EnvelopeMetrics,
} from './envelope.js';

import type { TransitClient } from './transit.js';

/** In-memory Transit: versioned per-key wrapping, with version rotation and shred (min version). */
class FakeTransit implements TransitClient {
  readonly latest = new Map<string, number>();
  minVersion = 1;
  down = false;
  readonly seen: string[] = [];

  private guard(): void {
    if (this.down) throw new EnvelopeError('KEK_UNAVAILABLE', 'down');
  }
  private ver(key: string): number {
    return this.latest.get(key) ?? 1;
  }
  private wrap(key: string, version: number, b64: string): string {
    return `vault:v${String(version)}:${Buffer.from(`${key}|${b64}`).toString('base64')}`;
  }
  encrypt(key: string, plaintextB64: string): Promise<string> {
    this.guard();
    this.seen.push(plaintextB64);
    return Promise.resolve(this.wrap(key, this.ver(key), plaintextB64));
  }
  decrypt(key: string, ciphertext: string): Promise<string> {
    this.guard();
    const [, v, body] = /^vault:v(\d+):(.+)$/.exec(ciphertext) ?? [];
    if (Number(v) < this.minVersion) {
      throw new EnvelopeError('KEK_DISABLED', 'disabled');
    }
    const [k, b64] = Buffer.from(body ?? '', 'base64')
      .toString()
      .split('|');
    if (k !== key) throw new EnvelopeError('KEK_UNAVAILABLE', 'wrong key');
    return Promise.resolve(b64 ?? '');
  }
  async rewrap(key: string, ciphertext: string): Promise<string> {
    return this.wrap(key, this.ver(key), await this.decrypt(key, ciphertext));
  }
}

const tenantA = randomUUID();
const tenantB = randomUUID();
const ctx = { purpose: 'provider-credential', secretId: 'sec_1' };

function setup(extra: Partial<Parameters<typeof createEnvelopeCrypto>[0]> = {}) {
  const transit = new FakeTransit();
  return { transit, crypto: createEnvelopeCrypto({ transit, ...extra }) };
}

afterEach(() => vi.restoreAllMocks());

describe('round trip', () => {
  it('returns the exact plaintext for binary, unicode and empty input', async () => {
    const { crypto } = setup();
    const binary = Buffer.from([0, 255, 1, 254, 128, 0]);
    for (const plaintext of [binary, 'pässwörd 🔑 日本語', '']) {
      const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext, context: ctx });
      const out = await crypto.decryptSecret(env, { tenantId: tenantA, context: ctx });
      expect(out.equals(typeof plaintext === 'string' ? Buffer.from(plaintext) : plaintext)).toBe(
        true,
      );
    }
  });

  it('round-trips arbitrary bytes (property)', async () => {
    const { crypto } = setup();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        const env = await crypto.encryptSecret({
          tenantId: tenantA,
          plaintext: bytes,
          context: ctx,
        });
        const out = await crypto.decryptSecret(env, { tenantId: tenantA, context: ctx });
        expect([...out]).toEqual([...bytes]);
      }),
      { numRuns: 25 },
    );
  });

  it('produces a self-describing envelope with no plaintext', async () => {
    const { crypto } = setup();
    const env = await crypto.encryptSecret({
      tenantId: tenantA,
      plaintext: 'hunter2-secret',
      context: ctx,
    });
    expect(env).toMatchObject({
      v: 1,
      alg: 'AES-256-GCM',
      kekKey: `tenant-${tenantA}`,
      kekVersion: 1,
    });
    expect(env.wrappedDek).toMatch(/^vault:v1:/);
    expect(JSON.stringify(env)).not.toContain('hunter2-secret');
  });

  it('uses a fresh IV and DEK for every encryption', async () => {
    const { crypto, transit } = setup();
    const envs = await Promise.all(
      Array.from({ length: 200 }, () =>
        crypto.encryptSecret({ tenantId: tenantA, plaintext: 'same', context: ctx }),
      ),
    );
    expect(new Set(envs.map((e) => e.iv)).size).toBe(200);
    expect(new Set(transit.seen).size).toBe(200);
  });

  it('treats NFC and NFD context text as the same binding', async () => {
    const { crypto } = setup();
    const env = await crypto.encryptSecret({
      tenantId: tenantA,
      plaintext: 'x',
      context: { purpose: 'é' },
    });
    await expect(
      crypto.decryptSecret(env, { tenantId: tenantA, context: { purpose: 'é' } }),
    ).resolves.toBeInstanceOf(Buffer);
  });
});

describe('binding (AAD)', () => {
  it('rejects tenant B decrypting tenant A envelope without calling the KEK', async () => {
    const { crypto, transit } = setup();
    const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: ctx });
    const spy = vi.spyOn(transit, 'decrypt');
    await expect(
      crypto.decryptSecret(env, { tenantId: tenantB, context: ctx }),
    ).rejects.toMatchObject({
      code: 'AAD_MISMATCH',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a different purpose or secretId', async () => {
    const { crypto } = setup();
    const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: ctx });
    for (const context of [
      { ...ctx, purpose: 'other' },
      { purpose: ctx.purpose },
      { ...ctx, secretId: 'sec_2' },
    ]) {
      await expect(crypto.decryptSecret(env, { tenantId: tenantA, context })).rejects.toMatchObject(
        {
          code: 'AAD_MISMATCH',
        },
      );
    }
  });

  it('rejects a forged aadHash/kekKey that points at another tenant', async () => {
    const { crypto } = setup();
    const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: ctx });
    await expect(
      crypto.decryptSecret(
        { ...env, kekKey: `tenant-${tenantB}` },
        { tenantId: tenantA, context: ctx },
      ),
    ).rejects.toMatchObject({ code: 'AAD_MISMATCH' });
  });

  it('rejects a non-UUID tenant id and an empty purpose', async () => {
    const { crypto } = setup();
    await expect(
      crypto.encryptSecret({ tenantId: '../x', plaintext: 's', context: ctx }),
    ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
    await expect(
      crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: { purpose: '' } }),
    ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
  });
});

describe('integrity', () => {
  async function tampered(field: 'ct' | 'tag' | 'iv'): Promise<unknown> {
    const { crypto } = setup();
    const env = await crypto.encryptSecret({
      tenantId: tenantA,
      plaintext: 'secret value',
      context: ctx,
    });
    const raw = Buffer.from(env[field], 'base64');
    raw[0] = (raw[0] ?? 0) ^ 1;
    const bad: Envelope = { ...env, [field]: raw.toString('base64') };
    return crypto.decryptSecret(bad, { tenantId: tenantA, context: ctx }).catch((e: unknown) => e);
  }

  it.each(['ct', 'tag', 'iv'] as const)(
    'fails GCM authentication when %s is modified',
    async (field) => {
      expect(await tampered(field)).toMatchObject({ code: 'SECRET_DECRYPT_FAILED' });
    },
  );

  it('rejects malformed envelopes', async () => {
    const { crypto } = setup();
    const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: ctx });
    const bad: unknown[] = [
      { ...env, v: 2 },
      { ...env, alg: 'AES-128-GCM' },
      { ...env, iv: 'AAAA' },
      { ...env, tag: '!!' },
      { ...env, wrappedDek: 'plain' },
    ];
    for (const e of bad) {
      await expect(
        crypto.decryptSecret(e as Envelope, { tenantId: tenantA, context: ctx }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
    }
  });
});

describe('limits and failure modes', () => {
  it('caps plaintext at 1 MiB by default and honours an override', async () => {
    const { crypto } = setup();
    await expect(
      crypto.encryptSecret({
        tenantId: tenantA,
        plaintext: Buffer.alloc(1024 * 1024 + 1),
        context: ctx,
      }),
    ).rejects.toMatchObject({ code: 'SECRET_TOO_LARGE' });
    await expect(
      crypto.encryptSecret({
        tenantId: tenantA,
        plaintext: Buffer.alloc(1024 * 1024),
        context: ctx,
      }),
    ).resolves.toBeDefined();
    const small = setup({ maxPlaintextBytes: 4 });
    await expect(
      small.crypto.encryptSecret({ tenantId: tenantA, plaintext: '12345', context: ctx }),
    ).rejects.toMatchObject({ code: 'SECRET_TOO_LARGE' });
  });

  it('fails closed with KEK_UNAVAILABLE when the KEK service is down', async () => {
    const { crypto, transit } = setup();
    const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: ctx });
    transit.down = true;
    await expect(
      crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: ctx }),
    ).rejects.toMatchObject({ code: 'KEK_UNAVAILABLE', retryable: true });
    await expect(
      crypto.decryptSecret(env, { tenantId: tenantA, context: ctx }),
    ).rejects.toMatchObject({
      code: 'KEK_UNAVAILABLE',
    });
  });

  it('fails KEK_DISABLED once the wrapping version is shredded', async () => {
    const { crypto, transit } = setup();
    const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: ctx });
    transit.minVersion = 2;
    await expect(
      crypto.decryptSecret(env, { tenantId: tenantA, context: ctx }),
    ).rejects.toMatchObject({
      code: 'KEK_DISABLED',
    });
  });
});

describe('rewrap', () => {
  it('moves the DEK to the newest KEK version and still decrypts', async () => {
    const { crypto, transit } = setup();
    const env = await crypto.encryptSecret({
      tenantId: tenantA,
      plaintext: 'rotate me',
      context: ctx,
    });
    expect(env.kekVersion).toBe(1);
    transit.latest.set(env.kekKey, 3);
    const next = await crypto.rewrap(env, { tenantId: tenantA });
    transit.minVersion = 3;
    expect(next.kekVersion).toBe(3);
    expect(next.wrappedDek).toMatch(/^vault:v3:/);
    expect({ iv: next.iv, tag: next.tag, ct: next.ct }).toEqual({
      iv: env.iv,
      tag: env.tag,
      ct: env.ct,
    });
    const out = await crypto.decryptSecret(next, { tenantId: tenantA, context: ctx });
    expect(out.toString()).toBe('rotate me');
  });

  it("refuses another tenant's envelope", async () => {
    const { crypto } = setup();
    const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: ctx });
    await expect(crypto.rewrap(env, { tenantId: tenantB })).rejects.toMatchObject({
      code: 'AAD_MISMATCH',
    });
  });
});

describe('observability and hygiene', () => {
  it('emits metrics and runs each operation in the secret.crypto span', async () => {
    const calls: string[] = [];
    const metrics: EnvelopeMetrics = {
      encrypt: () => calls.push('encrypt'),
      decrypt: (r) => calls.push(`decrypt:${r}`),
      rewrap: () => calls.push('rewrap'),
    };
    const spans: string[] = [];
    const { crypto } = setup({
      metrics,
      span: (n, fn) => {
        spans.push(n);
        return fn();
      },
    });
    const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext: 's', context: ctx });
    await crypto.decryptSecret(env, { tenantId: tenantA, context: ctx });
    await crypto.decryptSecret(env, { tenantId: tenantB, context: ctx }).catch(() => undefined);
    await crypto.rewrap(env, { tenantId: tenantA });
    expect(calls).toEqual(['encrypt', 'decrypt:ok', 'decrypt:error', 'rewrap']);
    expect(spans).toEqual(new Array(4).fill('secret.crypto'));
  });

  it('never writes plaintext or the DEK to any log stream or error', async () => {
    const secret = 'TOP-SECRET-PLAINTEXT-0451';
    const writes: string[] = [];
    const sink = (chunk: unknown): boolean => {
      writes.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(sink);
    vi.spyOn(process.stderr, 'write').mockImplementation(sink);
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const { crypto, transit } = setup();
    const env = await crypto.encryptSecret({ tenantId: tenantA, plaintext: secret, context: ctx });
    const errors: unknown[] = [];
    await crypto
      .decryptSecret(
        { ...env, ct: Buffer.from('zz').toString('base64') },
        { tenantId: tenantA, context: ctx },
      )
      .catch((e: unknown) => errors.push(e));
    await crypto
      .decryptSecret(env, { tenantId: tenantB, context: ctx })
      .catch((e: unknown) => errors.push(e));
    const dekB64 = transit.seen[0] ?? '';
    const everything = [
      ...writes,
      ...[log, err, warn].flatMap((s) => s.mock.calls.flat().map(String)),
      ...errors.map((e) => `${String(e)} ${JSON.stringify(e)}`),
    ].join('\n');
    expect(dekB64.length).toBeGreaterThan(0);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(dekB64);
  });
});
