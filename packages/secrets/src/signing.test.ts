import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type SigningAuditEvent,
  type SigningMetrics,
  createSigningKeyService,
  signingConfigFromEnv,
} from './signing.js';

import type { OpenBaoClient, OpenBaoResponse } from './openbao.js';
import type { Ed25519Jwk } from '@blackwing/crypto';

const KEY = 'bw-sa-signing';
const SA_ID = '0190a3c0-0000-7000-8000-000000000001';
const TENANT = '0190a3c0-0000-7000-8000-0000000000aa';
const body = new TextEncoder().encode('{"id":"sa-1","maxIntrusiveness":"safe"}');

interface Version {
  readonly privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  readonly raw: Buffer;
}

/**
 * Transit fake for an Ed25519 signing key: versions with real key pairs, `key_version` pinning and the
 * `vault:vN:` signature shape. The private key never leaves the fake, as in OpenBao.
 */
class FakeTransit implements OpenBaoClient {
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  readonly versions: Version[] = [];
  /** Set to make every call fail like a sealed or unreachable server. */
  down = false;
  /** Overrides the key document (type, exportable, keys) for negative cases. */
  overrides: Record<string, unknown> = {};
  /** Forces the `vault:vN:` prefix returned by sign, to model a version mismatch. */
  forcedSignaturePrefix: string | undefined;
  /** When set, the key does not exist (404). */
  missing = false;

  constructor() {
    this.addVersion();
  }

  addVersion(): void {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    this.versions.push({ privateKey, raw: Buffer.from(raw) });
  }

  get latest(): number {
    return this.versions.length;
  }

  request(method: string, path: string, body?: unknown): Promise<OpenBaoResponse> {
    this.calls.push({ method, path, body });
    if (this.down) return Promise.reject(new Error('sealed'));
    const keyPath = `transit/keys/${KEY}`;
    if (this.missing && path.startsWith(keyPath)) {
      return Promise.resolve({ status: 404, data: undefined });
    }
    if (method === 'GET' && path === keyPath) {
      const keys: Record<string, { public_key: string }> = {};
      this.versions.forEach((v, i) => {
        keys[String(i + 1)] = { public_key: v.raw.toString('base64') };
      });
      return Promise.resolve({
        status: 200,
        data: {
          type: 'ed25519',
          exportable: false,
          latest_version: this.latest,
          keys,
          ...this.overrides,
        },
      });
    }
    if (method === 'POST' && path === `${keyPath}/rotate`) {
      this.addVersion();
      return Promise.resolve({ status: 204, data: undefined });
    }
    if (method === 'POST' && path === `transit/sign/${KEY}`) {
      const req = body as { input: string; key_version: number };
      const version = this.versions[req.key_version - 1];
      if (version === undefined) return Promise.reject(new Error('no such version'));
      const sig = sign(null, Buffer.from(req.input, 'base64'), version.privateKey).toString(
        'base64',
      );
      const prefix = this.forcedSignaturePrefix ?? `vault:v${req.key_version}:`;
      return Promise.resolve({ status: 200, data: { signature: `${prefix}${sig}` } });
    }
    return Promise.resolve({ status: 404, data: undefined });
  }
}

function setup(options: { ttl?: number; now?: () => number } = {}) {
  const transit = new FakeTransit();
  const events: SigningAuditEvent[] = [];
  const metrics = { signs: [] as string[], refreshes: 0 };
  const mx: SigningMetrics = {
    sign: (r) => metrics.signs.push(r),
    jwksCacheRefresh: () => {
      metrics.refreshes += 1;
    },
  };
  let clock = 1_700_000_000_000;
  const service = createSigningKeyService({
    client: transit,
    audit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
    metrics: mx,
    now: options.now ?? (() => clock),
    config: { jwksTtlS: options.ttl ?? 300 },
  });
  return {
    transit,
    events,
    metrics,
    service,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function codeOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => (error as { code?: unknown }).code,
  );
}

const signOnce = (service: ReturnType<typeof setup>['service']) =>
  service.signEnvelope({ tenantId: TENANT, saId: SA_ID, canonicalBytes: body });

function jwkFor(keys: readonly Ed25519Jwk[], kid: string): Ed25519Jwk {
  const jwk = keys.find((k) => k.kid === kid);
  if (jwk === undefined) throw new Error(`no JWK for ${kid}`);
  return jwk;
}

/** Verifies the compact detached JWS against the canonical body with the exported JWK. */
function verifyWithJwk(compact: string, jwk: Ed25519Jwk): boolean {
  const [header, , sig] = compact.split('.');
  const publicKey = createPublicKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    format: 'jwk',
  });
  const signingInput = new TextEncoder().encode(
    `${header ?? ''}.${Buffer.from(body).toString('base64url')}`,
  );
  return verify(null, signingInput, publicKey, Buffer.from(sig ?? '', 'base64url'));
}

function syncCodeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown }).code;
  }
  return undefined;
}

describe('signEnvelope', () => {
  it('signs with the current version, names it in kid and verifies with the exported JWK', async () => {
    const { service } = setup();
    const signed = await signOnce(service);
    expect(signed).toMatchObject({
      signingKeyId: `${KEY}:v1`,
      iat: 1_700_000_000,
    });
    expect(signed.envelopeHash).toMatch(/^[0-9a-f]{64}$/);
    const { keys } = await service.getPublicJwks();
    expect(verifyWithJwk(signed.signature, jwkFor(keys, signed.signingKeyId))).toBe(true);
  });

  it('pins the key version and signs exactly header.payload (kid names the signing version)', async () => {
    const { service, transit } = setup();
    await signOnce(service);
    const signCall = transit.calls.find((c) => c.path === `transit/sign/${KEY}`);
    const req = signCall?.body as { input: string; key_version: number };
    expect(req.key_version).toBe(1);
    const [header, payload, ...rest] = Buffer.from(req.input, 'base64').toString('utf8').split('.');
    expect(rest).toEqual([]);
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toMatchObject({
      alg: 'EdDSA',
      kid: `${KEY}:v1`,
    });
    expect(Buffer.from(payload ?? '', 'base64url').equals(Buffer.from(body))).toBe(true);
  });

  it('writes one authz.sa.signed audit event with the sa id, key id and envelope hash', async () => {
    const { service, events } = setup();
    const signed = await signOnce(service);
    expect(events).toEqual([
      {
        tenantId: TENANT,
        action: 'authz.sa.signed',
        metadata: {
          sa_id: SA_ID,
          signing_key_id: `${KEY}:v1`,
          envelope_hash: signed.envelopeHash,
        },
      },
    ]);
  });

  it('counts an ok sign once', async () => {
    const { service, metrics } = setup();
    await signOnce(service);
    expect(metrics.signs).toEqual(['ok']);
  });

  it('fails closed with AUTHZ_SIGNER_UNAVAILABLE when OpenBao is down, with no audit and an error count', async () => {
    const { service, transit, events, metrics } = setup();
    transit.down = true;
    expect(await codeOf(signOnce(service))).toBe('AUTHZ_SIGNER_UNAVAILABLE');
    expect(events).toEqual([]);
    expect(metrics.signs).toEqual(['error']);
  });

  it('fails closed when the key does not exist', async () => {
    const { service, transit } = setup();
    transit.missing = true;
    expect(await codeOf(signOnce(service))).toBe('AUTHZ_SIGNER_UNAVAILABLE');
  });

  it('refuses a signature whose version differs from the pinned version (rotation race)', async () => {
    const { service, transit } = setup();
    transit.forcedSignaturePrefix = 'vault:v9:';
    expect(await codeOf(signOnce(service))).toBe('AUTHZ_SIGNER_UNAVAILABLE');
  });

  it('refuses a sign response with no signature', async () => {
    const { service, transit } = setup();
    transit.forcedSignaturePrefix = 'not-a-vault-signature';
    expect(await codeOf(signOnce(service))).toBe('AUTHZ_SIGNER_UNAVAILABLE');
  });

  it('refuses a key that is exportable or not ed25519 (never sign with a key we did not make)', async () => {
    const exportable = setup();
    exportable.transit.overrides = { exportable: true };
    expect(await codeOf(signOnce(exportable.service))).toBe('INTERNAL');
    const wrongType = setup();
    wrongType.transit.overrides = { type: 'rsa-2048' };
    expect(await codeOf(signOnce(wrongType.service))).toBe('INTERNAL');
  });

  it('refuses a key document that lacks a latest version or a public key', async () => {
    const noLatest = setup();
    noLatest.transit.overrides = { latest_version: 0 };
    expect(await codeOf(signOnce(noLatest.service))).toBe('INTERNAL');
    const noPublic = setup();
    noPublic.transit.overrides = { keys: {} };
    expect(await codeOf(signOnce(noPublic.service))).toBe('INTERNAL');
    const shortKey = setup();
    shortKey.transit.overrides = {
      keys: { '1': { public_key: Buffer.from('short').toString('base64') } },
    };
    expect(await codeOf(signOnce(shortKey.service))).toBe('INTERNAL');
  });

  it('a failing audit sink fails the call (no signature is released unaudited) and counts an error', async () => {
    const transit = new FakeTransit();
    const service = createSigningKeyService({
      client: transit,
      audit: () => Promise.reject(new Error('audit down')),
      metrics: { sign: () => undefined, jwksCacheRefresh: () => undefined },
    });
    await expect(signOnce(service)).rejects.toThrow('audit down');
  });

  it('rejects a non-integer clock reading through the iat check', async () => {
    const { service } = setup({ now: () => Number.NaN });
    await expect(signOnce(service)).rejects.toThrow(RangeError);
  });
});

describe('rotateSigningKey', () => {
  it('rotates to a new version; new SAs sign with it and the old signature still verifies', async () => {
    const { service } = setup();
    const before = await signOnce(service);
    const rotated = await service.rotateSigningKey(TENANT);
    expect(rotated).toEqual({ keyName: KEY, latestVersion: 2 });
    const after = await signOnce(service);
    expect(after.signingKeyId).toBe(`${KEY}:v2`);
    const { keys } = await service.getPublicJwks();
    expect(verifyWithJwk(before.signature, jwkFor(keys, before.signingKeyId))).toBe(true);
    expect(verifyWithJwk(after.signature, jwkFor(keys, after.signingKeyId))).toBe(true);
  });

  it('writes an authz.signing_key.rotated audit event with the new version', async () => {
    const { service, events } = setup();
    await service.rotateSigningKey(TENANT);
    expect(events.at(-1)).toEqual({
      tenantId: TENANT,
      action: 'authz.signing_key.rotated',
      metadata: { key_name: KEY, version: 2 },
    });
  });

  it('fails closed on a missing key and never calls rotate', async () => {
    const { service, transit } = setup();
    transit.missing = true;
    expect(await codeOf(service.rotateSigningKey(TENANT))).toBe('AUTHZ_SIGNER_UNAVAILABLE');
    expect(transit.calls.some((c) => c.path.endsWith('/rotate'))).toBe(false);
  });

  it('drops the cached key set so verifiers see the new version at once', async () => {
    const { service } = setup({ ttl: 300 });
    expect((await service.getPublicJwks()).keys).toHaveLength(1);
    await service.rotateSigningKey(TENANT);
    expect((await service.getPublicJwks()).keys.map((k) => k.kid)).toEqual([
      `${KEY}:v1`,
      `${KEY}:v2`,
    ]);
  });
});

describe('getPublicJwks', () => {
  it('returns every Transit version still held, including deprecated ones, in version order', async () => {
    const { service, transit } = setup();
    transit.addVersion();
    transit.addVersion();
    const { keys } = await service.getPublicJwks();
    expect(keys.map((k) => k.kid)).toEqual([`${KEY}:v1`, `${KEY}:v2`, `${KEY}:v3`]);
    for (const k of keys) {
      expect(k).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    }
  });

  it('caches the set for the TTL and refreshes after it, counting each refresh', async () => {
    const { service, transit, metrics, advance } = setup({ ttl: 300 });
    await service.getPublicJwks();
    await service.getPublicJwks();
    const reads = () => transit.calls.filter((c) => c.path === `transit/keys/${KEY}`).length;
    expect(reads()).toBe(1);
    advance(299_999);
    await service.getPublicJwks();
    expect(reads()).toBe(1);
    advance(1);
    await service.getPublicJwks();
    expect(reads()).toBe(2);
    expect(metrics.refreshes).toBe(2);
  });

  it('fails closed when OpenBao is unreachable (no stale key set is served silently after expiry)', async () => {
    const { service, transit, advance } = setup({ ttl: 300 });
    await service.getPublicJwks();
    advance(300_000);
    transit.down = true;
    expect(await codeOf(service.getPublicJwks())).toBe('AUTHZ_SIGNER_UNAVAILABLE');
  });

  it('fails closed on a malformed public key in the key document', async () => {
    const { service, transit } = setup();
    transit.overrides = { keys: { '1': { public_key: 'AAAA' } } };
    expect(await codeOf(service.getPublicJwks())).toBe('INTERNAL');
  });
});

describe('signingConfigFromEnv', () => {
  it('uses the documented defaults for an empty environment', () => {
    expect(signingConfigFromEnv({})).toEqual({
      keyName: 'bw-sa-signing',
      transitMount: 'transit',
      jwksTtlS: 300,
    });
  });

  it('reads the three overrides', () => {
    expect(
      signingConfigFromEnv({
        AUTHZ_SIGNING_KEY_NAME: 'sa-key-2',
        OPENBAO_TRANSIT_MOUNT: 'transit-eu',
        AUTHZ_JWKS_TTL_S: '60',
      }),
    ).toEqual({ keyName: 'sa-key-2', transitMount: 'transit-eu', jwksTtlS: 60 });
  });

  it.each([
    { AUTHZ_SIGNING_KEY_NAME: '../etc' },
    { AUTHZ_SIGNING_KEY_NAME: 'a/b' },
    { AUTHZ_SIGNING_KEY_NAME: 'UPPER' },
    { OPENBAO_TRANSIT_MOUNT: 'x/../y' },
    { AUTHZ_JWKS_TTL_S: '0' },
    { AUTHZ_JWKS_TTL_S: '3601' },
    { AUTHZ_JWKS_TTL_S: 'soon' },
    { AUTHZ_JWKS_TTL_S: '1.5' },
  ])('refuses an invalid value %j', (env) => {
    expect(syncCodeOf(() => signingConfigFromEnv(env))).toBe('CONFIG_INVALID');
  });
});
