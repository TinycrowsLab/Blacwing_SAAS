import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  type Ed25519Jwk,
  type EnvelopeSigningKey,
  ed25519Jwk,
  signCanonicalJws,
} from '@blackwing/crypto';

import { BASELINE_VERSION, loadBaseline } from './baseline.js';
import { SCHEMA_VERSION } from './schema.js';
import {
  buildPolicySnapshotBody,
  POLICY_SNAPSHOT_TYP,
  type PolicySnapshotBody,
  type PolicySnapshotObjectStore,
  type PolicySnapshotStore,
  policySnapshotBodySchema,
  policySnapshotCanonicalBytes,
  policySnapshotId,
  policySnapshotObjectKey,
  publishPolicySnapshot,
  signPolicySnapshot,
  verifyPolicySnapshot,
} from './snapshot.js';
import {
  assembleEffectivePolicySet,
  policySourceSha256,
  type TenantPolicyVersionRef,
} from './tenant-policy.js';

const TENANT = '0196a6a2-7b1c-7d2e-8f3a-1b2c3d4e5f60';
const OTHER_TENANT = '0196a6a2-7b1c-7d2e-8f3a-aaaaaaaaaaaa';
const BUILT_AT = new Date('2026-11-01T10:00:00.000Z');
const TENANT_SOURCE =
  'permit (principal, action, resource)\n  when { context.intrusiveness == "passive" };\n';
const SCHEMA = 'namespace Blackwing { entity Asset; }\n';

interface TestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: Ed25519Jwk;
  readonly signing: EnvelopeSigningKey;
}

/** An Ed25519 key with the shape `SigningKeyService.envelopeSigningKey()` returns: a kid and a signer. */
function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    kid,
    privateKey,
    jwk: ed25519Jwk(kid, new Uint8Array(raw)),
    signing: {
      kid,
      sign: (input) => Promise.resolve(new Uint8Array(sign(null, Buffer.from(input), privateKey))),
    },
  };
}

const active = (version: number, source = TENANT_SOURCE): TenantPolicyVersionRef => ({
  version,
  sha256: policySourceSha256(source),
  cedarSource: source,
});

function bodyFor(
  activeVersion: TenantPolicyVersionRef | null,
  tenantId = TENANT,
): PolicySnapshotBody {
  return buildPolicySnapshotBody({
    tenantId,
    builtAt: BUILT_AT,
    effective: assembleEffectivePolicySet(activeVersion, loadBaseline()),
    cedarSchema: SCHEMA,
  });
}

/** Signs a hand-made body with a given typ, bypassing the builder (for negative tests). */
async function signRaw(
  body: unknown,
  key: EnvelopeSigningKey,
  typ = POLICY_SNAPSHOT_TYP,
): Promise<string> {
  return signCanonicalJws(new TextEncoder().encode(JSON.stringify(sortKeys(body))), key, typ);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => sortKeys(item));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

describe('policy snapshot body', () => {
  it('pins the baseline, the schema and the tenant layer, with the baseline first', () => {
    const body = bodyFor(active(3));
    expect(body).toMatchObject({
      snapshotVersion: 1,
      tenantId: TENANT,
      builtAt: '2026-11-01T10:00:00.000Z',
      schemaVersion: SCHEMA_VERSION,
      cedarSchema: SCHEMA,
      baselineVersion: BASELINE_VERSION,
      tenantPolicyVersion: 3,
      tenantSha256: policySourceSha256(TENANT_SOURCE),
    });
    expect(body.policies.map((p) => p.id)).toEqual(['baseline', 'tenant']);
    expect(body.policies[1]?.source).toBe(TENANT_SOURCE);
    expect(policySnapshotBodySchema.safeParse(body).success).toBe(true);
  });

  it('is baseline-only when the tenant has no active version (never an empty set)', () => {
    const body = bodyFor(null);
    expect(body.tenantPolicyVersion).toBeNull();
    expect(body.tenantSha256).toBeNull();
    expect(body.policies.map((p) => p.id)).toEqual(['baseline']);
    expect(body.policies[0]?.source.length).toBeGreaterThan(0);
  });

  it('gives a stable snapshot id: the sha256 of the canonical (JCS) bytes, with sorted members', () => {
    const body = bodyFor(active(1));
    const canonical = policySnapshotCanonicalBytes(body);
    const text = Buffer.from(canonical).toString('utf8');
    expect(text.startsWith('{"baselineSha256":')).toBe(true);
    expect(text).toBe(JSON.stringify(sortKeys(body)));
    expect(policySnapshotId(canonical)).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(policySnapshotId(policySnapshotCanonicalBytes(bodyFor(active(1))))).toBe(
      policySnapshotId(canonical),
    );
  });

  it('gives a new id when the active tenant version changes', () => {
    const first = policySnapshotId(policySnapshotCanonicalBytes(bodyFor(active(1))));
    const second = policySnapshotId(
      policySnapshotCanonicalBytes(bodyFor(active(2, `${TENANT_SOURCE}\n// second\n`))),
    );
    expect(second).not.toBe(first);
  });

  it('reads the shipped schema when none is passed', () => {
    const body = buildPolicySnapshotBody({
      tenantId: TENANT,
      builtAt: BUILT_AT,
      effective: assembleEffectivePolicySet(null, loadBaseline()),
    });
    expect(body.cedarSchema).toContain('namespace');
  });
});

describe('signing and verification', () => {
  it('round-trips: a signed snapshot verifies and reports its id and key id', async () => {
    const key = makeKey('bw-sa-signing:v1');
    const { token, snapshotId, signingKeyId } = await signPolicySnapshot(
      bodyFor(active(1)),
      key.signing,
    );
    expect(signingKeyId).toBe('bw-sa-signing:v1');

    const result = verifyPolicySnapshot(token, { keys: [key.jwk] }, TENANT);
    expect(result).toMatchObject({
      ok: true,
      snapshotId,
      kid: 'bw-sa-signing:v1',
      body: bodyFor(active(1)),
    });
  });

  it('refuses a token with one byte flipped in the payload (tamper detection)', async () => {
    const key = makeKey('k1');
    const { token } = await signPolicySnapshot(bodyFor(active(1)), key.signing);
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const flipped = payload.startsWith('e') ? `f${payload.slice(1)}` : `e${payload.slice(1)}`;
    expect(verifyPolicySnapshot(`${header}.${flipped}.${signature}`, { keys: [key.jwk] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a token whose signature was made by another key with the same kid', async () => {
    const real = makeKey('k1');
    const forged = makeKey('k1');
    const { token } = await signPolicySnapshot(bodyFor(active(1)), forged.signing);
    expect(verifyPolicySnapshot(token, { keys: [real.jwk] })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('still verifies a snapshot signed with a rotated-out key while its JWK stays in the set', async () => {
    const v1 = makeKey('bw-sa-signing:v1');
    const v2 = makeKey('bw-sa-signing:v2');
    const old = await signPolicySnapshot(bodyFor(active(1)), v1.signing);
    const fresh = await signPolicySnapshot(bodyFor(active(2)), v2.signing);

    const jwks = { keys: [v1.jwk, v2.jwk] };
    expect(verifyPolicySnapshot(old.token, jwks)).toMatchObject({
      ok: true,
      kid: 'bw-sa-signing:v1',
    });
    expect(verifyPolicySnapshot(fresh.token, jwks)).toMatchObject({
      ok: true,
      kid: 'bw-sa-signing:v2',
    });
  });

  it('fails closed when the signing kid is not in the key set', async () => {
    const v1 = makeKey('bw-sa-signing:v1');
    const { token } = await signPolicySnapshot(bodyFor(active(1)), v1.signing);
    expect(verifyPolicySnapshot(token, { keys: [makeKey('bw-sa-signing:v2').jwk] })).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('refuses a snapshot presented for another tenant', async () => {
    const key = makeKey('k1');
    const { token } = await signPolicySnapshot(bodyFor(active(1)), key.signing);
    expect(verifyPolicySnapshot(token, { keys: [key.jwk] }, OTHER_TENANT)).toEqual({
      ok: false,
      reason: 'wrong_tenant',
    });
  });

  it('refuses a token of another JWS type, even when it is correctly signed', async () => {
    const key = makeKey('k1');
    const body = bodyFor(active(1));
    const token = await signRaw(body, key.signing, 'application/sa-envelope+jcs');
    expect(verifyPolicySnapshot(token, { keys: [key.jwk] })).toEqual({
      ok: false,
      reason: 'wrong_type',
    });
  });

  it('refuses a malformed or unsigned-looking token without throwing', () => {
    const key = makeKey('k1');
    for (const token of ['', 'not-a-jws', 'a.b', 'e30..', `${'x'.repeat(10)}.y.z`]) {
      expect(verifyPolicySnapshot(token, { keys: [key.jwk] }).ok).toBe(false);
    }
  });

  it('refuses a signed body that carries an unknown field (strict body schema)', async () => {
    const key = makeKey('k1');
    const token = await signRaw({ ...bodyFor(active(1)), extra: true }, key.signing);
    expect(verifyPolicySnapshot(token, { keys: [key.jwk] })).toEqual({
      ok: false,
      reason: 'bad_body',
    });
  });

  it('refuses a signed body whose tenant digest does not match the tenant source it carries', async () => {
    const key = makeKey('k1');
    const body = bodyFor(active(1));
    const tampered = { ...body, tenantSha256: policySourceSha256('other source\n') };
    const token = await signRaw(tampered, key.signing);
    expect(verifyPolicySnapshot(token, { keys: [key.jwk] })).toEqual({
      ok: false,
      reason: 'tenant_digest_mismatch',
    });
  });

  it('refuses a body whose tenant layer and tenant pins disagree', async () => {
    const key = makeKey('k1');
    const body = bodyFor(active(1));
    const token = await signRaw({ ...body, tenantPolicyVersion: null }, key.signing);
    expect(verifyPolicySnapshot(token, { keys: [key.jwk] })).toEqual({
      ok: false,
      reason: 'bad_body',
    });
  });

  it('accepts a body with no tenant layer (baseline only)', async () => {
    const key = makeKey('k1');
    const { token } = await signPolicySnapshot(bodyFor(null), key.signing);
    expect(verifyPolicySnapshot(token, { keys: [key.jwk] })).toMatchObject({ ok: true });
  });
});

describe('publishPolicySnapshot', () => {
  function fakes() {
    const puts: { key: string; bytes: Uint8Array }[] = [];
    const rows: unknown[] = [];
    const objects: PolicySnapshotObjectStore = {
      put: vi.fn((key: string, bytes: Uint8Array) => {
        puts.push({ key, bytes });
        return Promise.resolve();
      }),
    };
    const store: PolicySnapshotStore = {
      insert: vi.fn((record) => {
        rows.push(record);
        return Promise.resolve();
      }),
    };
    return { puts, rows, objects, store };
  }

  it('signs, stores the bytes under the tenant prefix, then records the row', async () => {
    const key = makeKey('bw-sa-signing:v1');
    const { puts, rows, objects, store } = fakes();
    const published = await publishPolicySnapshot(
      { tenantId: TENANT, activeVersion: active(4), cedarSchema: SCHEMA },
      { signingKey: key.signing, objects, store, now: () => BUILT_AT },
    );

    expect(published.objectKey).toBe(policySnapshotObjectKey(TENANT, published.snapshotId));
    expect(published.objectKey).toMatch(
      new RegExp(`^t/${TENANT}/policy-snapshots/[0-9a-f]{64}\\.jws$`),
    );
    expect(puts).toHaveLength(1);
    expect(Buffer.from(puts[0]?.bytes ?? []).toString('utf8')).toBe(published.token);
    expect(verifyPolicySnapshot(published.token, { keys: [key.jwk] }, TENANT)).toMatchObject({
      ok: true,
      snapshotId: published.snapshotId,
    });
    expect(rows).toEqual([
      {
        tenantId: TENANT,
        snapshotSha256: published.snapshotId,
        signingKeyId: 'bw-sa-signing:v1',
        baselineVersion: BASELINE_VERSION,
        tenantPolicyVersion: 4,
        objectKey: published.objectKey,
      },
    ]);
  });

  it('publishes nothing when the signer is unavailable (fail closed, no unsigned snapshot)', async () => {
    const { puts, rows, objects, store } = fakes();
    const failing: EnvelopeSigningKey = {
      kid: 'bw-sa-signing:v1',
      sign: () => Promise.reject(new Error('openbao unreachable')),
    };
    await expect(
      publishPolicySnapshot(
        { tenantId: TENANT, activeVersion: null, cedarSchema: SCHEMA },
        {
          signingKey: failing,
          objects,
          store,
        },
      ),
    ).rejects.toThrow('openbao unreachable');
    expect(puts).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it('retries a failed object write and records the row once it succeeds', async () => {
    const key = makeKey('k1');
    const { rows, store } = fakes();
    let calls = 0;
    const objects: PolicySnapshotObjectStore = {
      put: () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new Error('object store down')) : Promise.resolve();
      },
    };
    await publishPolicySnapshot(
      { tenantId: TENANT, activeVersion: null, cedarSchema: SCHEMA },
      {
        signingKey: key.signing,
        objects,
        store,
      },
    );
    expect(calls).toBe(3);
    expect(rows).toHaveLength(1);
  });

  it('surfaces an object-store outage after the attempts and records nothing', async () => {
    const key = makeKey('k1');
    const { rows, store } = fakes();
    let calls = 0;
    const objects: PolicySnapshotObjectStore = {
      put: () => {
        calls += 1;
        return Promise.reject(new Error('object store down'));
      },
    };
    await expect(
      publishPolicySnapshot(
        { tenantId: TENANT, activeVersion: null, cedarSchema: SCHEMA },
        {
          signingKey: key.signing,
          objects,
          store,
          objectWriteAttempts: 2,
        },
      ),
    ).rejects.toThrow('object store down');
    expect(calls).toBe(2);
    expect(rows).toHaveLength(0);
  });

  it('refuses a non-positive attempt count', async () => {
    const key = makeKey('k1');
    const { objects, store } = fakes();
    await expect(
      publishPolicySnapshot(
        { tenantId: TENANT, activeVersion: null, cedarSchema: SCHEMA },
        {
          signingKey: key.signing,
          objects,
          store,
          objectWriteAttempts: 0,
        },
      ),
    ).rejects.toThrow(RangeError);
  });

  it('builds a new immutable snapshot with a new id on each activation', async () => {
    const key = makeKey('k1');
    const { objects, store } = fakes();
    const ports = { signingKey: key.signing, objects, store };
    const one = await publishPolicySnapshot(
      { tenantId: TENANT, activeVersion: active(1), cedarSchema: SCHEMA },
      ports,
    );
    const two = await publishPolicySnapshot(
      {
        tenantId: TENANT,
        activeVersion: active(2, `${TENANT_SOURCE}// v2\n`),
        cedarSchema: SCHEMA,
      },
      ports,
    );
    expect(two.snapshotId).not.toBe(one.snapshotId);
    expect(two.objectKey).not.toBe(one.objectKey);
  });
});

describe('the signer port', () => {
  it('signs through the port only: the header names the kid and the typ, never key material', async () => {
    const key = makeKey('k1');
    const { token } = await signPolicySnapshot(bodyFor(active(1)), key.signing);
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(header).toEqual({ alg: 'EdDSA', kid: 'k1', typ: POLICY_SNAPSHOT_TYP });
  });
});
