import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createEnvelopeCrypto, type Envelope, EnvelopeError } from './envelope.js';
import {
  createSecretRotation,
  type RewrapCandidate,
  type RewrapCursor,
  type RotationCommit,
  type RotationMetrics,
  type RotationRecord,
  type RotationStore,
  type SecretRotationAuditEvent,
} from './rotation.js';

import type { KekInfo } from './kek.js';
import type { TransitClient } from './transit.js';

/** In-memory Transit with real version semantics: wraps at the newest version, refuses below the floor. */
class VersionedTransit implements TransitClient {
  latest = 1;
  minVersion = 1;
  down = false;

  private guard(): void {
    if (this.down) throw new EnvelopeError('KEK_UNAVAILABLE', 'sealed');
  }
  private wrap(key: string, version: number, b64: string): string {
    return `vault:v${String(version)}:${Buffer.from(`${key}|${b64}`).toString('base64')}`;
  }
  private unwrap(key: string, ciphertext: string): string {
    const match = /^vault:v(\d+):(.+)$/.exec(ciphertext);
    if (match === null) throw new EnvelopeError('ENVELOPE_INVALID', 'bad ciphertext');
    if (Number(match[1]) < this.minVersion) throw new EnvelopeError('KEK_DISABLED', 'below floor');
    const [k, b64] = Buffer.from(match[2] ?? '', 'base64')
      .toString()
      .split('|');
    if (k !== key) throw new EnvelopeError('KEK_UNAVAILABLE', 'wrong key');
    return b64 ?? '';
  }
  encrypt(key: string, plaintextB64: string): Promise<string> {
    this.guard();
    return Promise.resolve(this.wrap(key, this.latest, plaintextB64));
  }
  decrypt(key: string, ciphertext: string): Promise<string> {
    this.guard();
    return Promise.resolve(this.unwrap(key, ciphertext));
  }
  rewrap(key: string, ciphertext: string): Promise<string> {
    this.guard();
    return Promise.resolve(this.wrap(key, this.latest, this.unwrap(key, ciphertext)));
  }
}

interface Row {
  id: string;
  tenantId: string;
  purpose: string | null;
  backend: RotationRecord['backend'];
  status: RotationRecord['status'];
  currentVersion: number;
  envelope: Envelope | null;
  externalLocator: Readonly<Record<string, unknown>> | null;
}

interface VersionRow {
  tenantId: string;
  secretId: string;
  version: number;
  envelope: Envelope | null;
  externalLocator: Readonly<Record<string, unknown>> | null;
  retiredAt: Date | null;
}

/** In-memory rotation store with the same guards as the SQL: tenant scope, optimistic version, eligibility. */
class MemoryRotationStore implements RotationStore {
  readonly secrets = new Map<string, Row>();
  readonly versions = new Map<string, VersionRow>();
  readonly saved: string[] = [];
  readonly log: string[];
  batchCalls = 0;
  saveAttempts = 0;
  /** Fails the n-th `saveRewrap` call once, like a crash mid-batch. */
  failSaveAttempt: number | undefined;
  forceConflict = false;

  constructor(log: string[]) {
    this.log = log;
  }

  private static versionKey(secretId: string, version: number): string {
    return `${secretId}/${String(version)}`;
  }

  loadForRotation(tenantId: string, secretId: string): Promise<RotationRecord | null> {
    const row = this.secrets.get(secretId);
    if (row?.tenantId !== tenantId) return Promise.resolve(null);
    return Promise.resolve({ ...row });
  }

  commitRotation(tenantId: string, commit: RotationCommit): Promise<boolean> {
    const row = this.secrets.get(commit.secretId);
    if (
      this.forceConflict ||
      row?.tenantId !== tenantId ||
      row.currentVersion !== commit.expectedVersion
    ) {
      return Promise.resolve(false);
    }
    row.envelope = commit.next.envelope;
    row.currentVersion = commit.next.version;
    const prevKey = MemoryRotationStore.versionKey(commit.secretId, commit.previous.version);
    const existing = this.versions.get(prevKey);
    if (existing === undefined) {
      this.versions.set(prevKey, {
        tenantId,
        secretId: commit.secretId,
        version: commit.previous.version,
        envelope: commit.previous.envelope,
        externalLocator: commit.previous.externalLocator,
        retiredAt: commit.previous.retiredAt,
      });
    } else {
      existing.retiredAt = commit.previous.retiredAt;
    }
    this.versions.set(MemoryRotationStore.versionKey(commit.secretId, commit.next.version), {
      tenantId,
      secretId: commit.secretId,
      version: commit.next.version,
      envelope: commit.next.envelope,
      externalLocator: null,
      retiredAt: null,
    });
    return Promise.resolve(true);
  }

  private candidates(tenantId: string, kekKey: string, before: number): RewrapCandidate[] {
    const due = (envelope: Envelope | null): boolean =>
      envelope !== null && envelope.kekKey === kekKey && envelope.kekVersion < before;
    const out: RewrapCandidate[] = [];
    for (const row of this.secrets.values()) {
      if (row.tenantId === tenantId && row.backend === 'openbao' && due(row.envelope)) {
        out.push({
          source: 'current',
          secretId: row.id,
          version: row.currentVersion,
          envelope: envelopeAt(row.envelope),
        });
      }
    }
    for (const v of this.versions.values()) {
      const owner = this.secrets.get(v.secretId);
      if (v.tenantId === tenantId && owner?.backend === 'openbao' && due(v.envelope)) {
        out.push({
          source: 'version',
          secretId: v.secretId,
          version: v.version,
          envelope: envelopeAt(v.envelope),
        });
      }
    }
    return out.sort((a, b) =>
      a.secretId !== b.secretId
        ? a.secretId < b.secretId
          ? -1
          : 1
        : a.version !== b.version
          ? a.version - b.version
          : a.source < b.source
            ? -1
            : a.source > b.source
              ? 1
              : 0,
    );
  }

  nextRewrapBatch(
    tenantId: string,
    kekKey: string,
    beforeVersion: number,
    after: RewrapCursor | undefined,
    limit: number,
  ): Promise<RewrapCandidate[]> {
    this.batchCalls += 1;
    const rest = this.candidates(tenantId, kekKey, beforeVersion).filter((c) => {
      if (after === undefined) return true;
      if (c.secretId !== after.secretId) return c.secretId > after.secretId;
      if (c.version !== after.version) return c.version > after.version;
      return c.source > after.source;
    });
    return Promise.resolve(rest.slice(0, limit));
  }

  remainingBelow(kekKey: string, version: number): number {
    return this.candidates(TENANT, kekKey, version).length;
  }

  saveRewrap(tenantId: string, candidate: RewrapCandidate, envelope: Envelope): Promise<boolean> {
    this.saveAttempts += 1;
    if (this.failSaveAttempt === this.saveAttempts) {
      this.failSaveAttempt = undefined;
      return Promise.reject(new Error('connection reset'));
    }
    if (candidate.source === 'current') {
      const row = this.secrets.get(candidate.secretId);
      if (row?.tenantId !== tenantId || row.currentVersion !== candidate.version) {
        return Promise.resolve(false);
      }
      row.envelope = envelope;
    } else {
      const v = this.versions.get(
        MemoryRotationStore.versionKey(candidate.secretId, candidate.version),
      );
      if (v?.tenantId !== tenantId) return Promise.resolve(false);
      v.envelope = envelope;
    }
    this.saved.push(`${candidate.source}:${candidate.secretId}:${String(candidate.version)}`);
    this.log.push('save');
    return Promise.resolve(true);
  }
}

/** Tenant KEK over the shared transit: a rotation bumps the transit's newest version, like OpenBao. */
class FakeKek {
  minVersion = 1;
  disabled = false;
  rotateDown = false;
  private readonly transit: VersionedTransit;
  private readonly store: MemoryRotationStore;
  private readonly log: string[];

  constructor(transit: VersionedTransit, store: MemoryRotationStore, log: string[]) {
    this.transit = transit;
    this.store = store;
    this.log = log;
  }

  private info(tenantId: string): KekInfo {
    return {
      keyName: `tenant-${tenantId}`,
      latestVersion: this.transit.latest,
      minDecryptionVersion: this.minVersion,
    };
  }
  rotateTenantKek(tenantId: string): Promise<KekInfo> {
    this.log.push('kek.rotate');
    if (this.rotateDown) return Promise.reject(new EnvelopeError('KEK_UNAVAILABLE', 'sealed'));
    this.transit.latest += 1;
    return Promise.resolve(this.info(tenantId));
  }
  getTenantKek(tenantId: string): Promise<KekInfo> {
    return Promise.resolve(this.info(tenantId));
  }
  setKekMinDecryptVersion(tenantId: string, version: number): Promise<KekInfo> {
    this.log.push(`kek.min:${String(version)}`);
    // The floor may only rise after every envelope of the tenant already sits at or above it.
    if (this.store.remainingBelow(`tenant-${tenantId}`, version) !== 0) {
      return Promise.reject(new Error('floor raised before rewrap completed'));
    }
    this.minVersion = version;
    this.transit.minVersion = version;
    return Promise.resolve(this.info(tenantId));
  }
  isTenantKekDisabled(): Promise<boolean> {
    return Promise.resolve(this.disabled);
  }
}

const TENANT = randomUUID();
const SECRET = randomUUID();
const OTHER = randomUUID();
const PURPOSE = 'asset_login';
const NOW = 1_000_000;
const GRACE = 3_600_000;

function setup(options: { batchSize?: number; graceMs?: number } = {}) {
  const log: string[] = [];
  const transit = new VersionedTransit();
  const crypto = createEnvelopeCrypto({ transit });
  const store = new MemoryRotationStore(log);
  const kek = new FakeKek(transit, store, log);
  const audits: SecretRotationAuditEvent[] = [];
  const metrics = {
    rotation: [] as string[],
    kekRotation: [] as string[],
    rewrapped: 0,
    rewrapError: 0,
  };
  const rotationMetrics: RotationMetrics = {
    rotation: (r) => metrics.rotation.push(r),
    kekRotation: (r) => metrics.kekRotation.push(r),
    rewrapped: () => {
      metrics.rewrapped += 1;
    },
    rewrapError: () => {
      metrics.rewrapError += 1;
    },
  };
  let clock = NOW;
  const service = createSecretRotation({
    store,
    crypto,
    kek,
    audit: (event) => {
      audits.push(event);
      return Promise.resolve();
    },
    graceMs: options.graceMs ?? GRACE,
    ...(options.batchSize === undefined ? {} : { rewrapBatchSize: options.batchSize }),
    metrics: rotationMetrics,
    now: () => clock,
  });
  return {
    service,
    transit,
    crypto,
    store,
    kek,
    audits,
    metrics,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

type Harness = ReturnType<typeof setup>;

/** Writes a live secret at version 1 (or the given state) the way the SECRETS writer would. */
async function seed(
  h: Pick<Harness, 'crypto' | 'store'>,
  overrides: Partial<Row> & { plaintext?: string } = {},
): Promise<void> {
  const { plaintext = 'v1-secret', ...rest } = overrides;
  const id = rest.id ?? SECRET;
  const tenantId = rest.tenantId ?? TENANT;
  const purpose = rest.purpose === undefined ? PURPOSE : rest.purpose;
  const backend = rest.backend ?? 'openbao';
  let envelope = rest.envelope ?? null;
  if (envelope === null && backend === 'openbao') {
    envelope = await h.crypto.encryptSecret({
      tenantId,
      plaintext,
      context: { secretId: id, purpose: purpose ?? '' },
    });
  }
  h.store.secrets.set(id, {
    id,
    tenantId,
    purpose,
    backend,
    status: rest.status ?? 'active',
    currentVersion: rest.currentVersion ?? 1,
    envelope,
    externalLocator: rest.externalLocator ?? null,
  });
}

/** The envelope a test expects to exist; a missing one fails the test loudly. */
function envelopeAt(value: Envelope | null | undefined): Envelope {
  if (value === null || value === undefined) throw new Error('expected an envelope');
  return value;
}

async function readAs(
  h: Harness,
  envelope: Envelope,
  secretId: string = SECRET,
  purpose: string = PURPOSE,
) {
  const bytes = await h.crypto.decryptSecret(envelope, {
    tenantId: TENANT,
    context: { secretId, purpose },
  });
  return bytes.toString('utf8');
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('rotateSecret', () => {
  it('issues version N+1, keeps the prior version readable and retires it after the grace period', async () => {
    const h = setup();
    await seed(h);
    const result = await h.service.rotateSecret({
      tenantId: TENANT,
      secretId: SECRET,
      plaintext: 'v2-secret',
    });

    expect(result).toMatchObject({ version: 2, previousVersion: 1 });
    expect(result.retiredAt.getTime()).toBe(NOW + GRACE);
    const current = h.store.secrets.get(SECRET);
    expect(current?.currentVersion).toBe(2);
    expect(await readAs(h, envelopeAt(current?.envelope))).toBe('v2-secret');

    const previous = h.store.versions.get(`${SECRET}/1`);
    expect(previous?.retiredAt?.getTime()).toBe(NOW + GRACE);
    expect(await readAs(h, envelopeAt(previous?.envelope))).toBe('v1-secret');
  });

  it('audits the rotation with ids and versions only, never the value', async () => {
    const h = setup();
    await seed(h);
    await h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2-secret' });
    expect(h.audits).toEqual([
      {
        tenantId: TENANT,
        action: 'secret.rotated',
        metadata: { secretId: SECRET, version: 2, previousVersion: 1 },
      },
    ]);
    expect(JSON.stringify(h.audits)).not.toContain('v2-secret');
    expect(h.metrics.rotation).toEqual(['ok']);
  });

  it('keeps the rows free of plaintext', async () => {
    const h = setup();
    await seed(h);
    await h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2-secret' });
    expect(
      JSON.stringify([...h.store.secrets.values(), ...h.store.versions.values()]),
    ).not.toContain('v2-secret');
  });

  it('moves a secret through several rotations, retiring each superseded version', async () => {
    const h = setup();
    await seed(h);
    await h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2' });
    h.advance(10);
    const third = await h.service.rotateSecret({
      tenantId: TENANT,
      secretId: SECRET,
      plaintext: 'v3',
    });
    expect(third).toMatchObject({ version: 3, previousVersion: 2 });
    expect(h.store.versions.get(`${SECRET}/2`)?.retiredAt?.getTime()).toBe(NOW + 10 + GRACE);
    expect(h.store.secrets.get(SECRET)?.currentVersion).toBe(3);
  });

  it.each([
    ['an unknown secret', {}, 'SECRET_NOT_FOUND'],
    ['a shredded secret', { status: 'shredded' as const }, 'SECRET_SHREDDED'],
    ['a disabled secret', { status: 'disabled' as const }, 'SECRET_DISABLED'],
  ])('refuses %s without writing', async (_label, state, code) => {
    const h = setup();
    if (code !== 'SECRET_NOT_FOUND') await seed(h, state);
    const error = await rejectionOf(
      h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2' }),
    );
    expect(error).toMatchObject({ code });
    expect(h.audits).toEqual([]);
    expect(h.metrics.rotation).toEqual(['error']);
    expect(h.store.versions.size).toBe(0);
  });

  it('does not rotate another tenant secret (tenant scope)', async () => {
    const h = setup();
    await seed(h);
    const error = await rejectionOf(
      h.service.rotateSecret({ tenantId: OTHER, secretId: SECRET, plaintext: 'v2' }),
    );
    expect(error).toMatchObject({ code: 'SECRET_NOT_FOUND' });
    expect(h.store.secrets.get(SECRET)?.currentVersion).toBe(1);
  });

  it('refuses a customer-owned secret until its external adapter exists, and leaves it alone', async () => {
    const h = setup();
    await seed(h, {
      backend: 'aws_kms',
      envelope: null,
      externalLocator: { arn: 'arn:example' },
    });
    const error = await rejectionOf(
      h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2' }),
    );
    expect(error).toMatchObject({ code: 'EXTERNAL_BACKEND_UNAVAILABLE' });
    expect(h.store.secrets.get(SECRET)?.currentVersion).toBe(1);
    expect(h.store.secrets.get(SECRET)?.externalLocator).toEqual({ arn: 'arn:example' });
  });

  it('refuses while the tenant KEK is disabled', async () => {
    const h = setup();
    await seed(h);
    h.kek.disabled = true;
    const error = await rejectionOf(
      h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2' }),
    );
    expect(error).toMatchObject({ code: 'KEK_DISABLED' });
    expect(h.store.secrets.get(SECRET)?.currentVersion).toBe(1);
  });

  it('rejects an empty value and a secret without a purpose to bind', async () => {
    const h = setup();
    await seed(h);
    await expect(
      h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: '' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const row = h.store.secrets.get(SECRET);
    if (row !== undefined) row.purpose = null;
    await expect(
      h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2' }),
    ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
  });

  it('fails with CONFLICT when another rotation moved the version first, and writes nothing', async () => {
    const h = setup();
    await seed(h);
    h.store.forceConflict = true;
    await expect(
      h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.store.versions.size).toBe(0);
    expect(h.audits).toEqual([]);
  });

  it('fails closed when the KEK cannot wrap the new value, and changes nothing', async () => {
    const h = setup();
    await seed(h);
    h.transit.down = true;
    await expect(
      h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2' }),
    ).rejects.toMatchObject({ code: 'KEK_UNAVAILABLE' });
    expect(h.store.secrets.get(SECRET)?.currentVersion).toBe(1);
    expect(h.metrics.rotation).toEqual(['error']);
  });

  it('surfaces an audit failure instead of reporting a silent rotation', async () => {
    const log: string[] = [];
    const transit = new VersionedTransit();
    const crypto = createEnvelopeCrypto({ transit });
    const store = new MemoryRotationStore(log);
    const kek = new FakeKek(transit, store, log);
    const service = createSecretRotation({
      store,
      crypto,
      kek,
      audit: () => Promise.reject(new Error('ledger down')),
      graceMs: GRACE,
      now: () => NOW,
    });
    await seed({ crypto, store }, { plaintext: 'v1' });
    await expect(
      service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2' }),
    ).rejects.toThrow('ledger down');
  });
});

describe('rotateTenantKek', () => {
  it('re-wraps every envelope of the tenant to the new KEK version and raises the floor last', async () => {
    const h = setup();
    await seed(h);
    await seed(h, { id: OTHER, plaintext: 'other-v1' });
    await h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2-secret' });
    const before = envelopeAt(h.store.secrets.get(SECRET)?.envelope);

    const result = await h.service.rotateTenantKek(TENANT);

    expect(result).toMatchObject({ latestVersion: 2, minDecryptionVersion: 2 });
    // current + its mirror + the retired v1 for SECRET, and the single version of OTHER
    expect(result.rewrapped).toBe(4);
    expect(h.store.remainingBelow(`tenant-${TENANT}`, 2)).toBe(0);
    expect(h.store.secrets.get(SECRET)?.envelope?.kekVersion).toBe(2);
    expect(h.store.versions.get(`${SECRET}/1`)?.envelope?.kekVersion).toBe(2);
    expect(h.log.indexOf('kek.min:2')).toBeGreaterThan(h.log.lastIndexOf('save'));
    // the data ciphertext is untouched: only the wrapped DEK changed
    const after = envelopeAt(h.store.secrets.get(SECRET)?.envelope);
    expect(after).toMatchObject({
      ct: before.ct,
      iv: before.iv,
      tag: before.tag,
      aadHash: before.aadHash,
    });
    expect(after.wrappedDek).not.toBe(before.wrappedDek);
  });

  it('still decrypts every secret, current and pinned, after the floor is raised', async () => {
    const h = setup();
    await seed(h);
    await h.service.rotateSecret({ tenantId: TENANT, secretId: SECRET, plaintext: 'v2-secret' });
    await h.service.rotateTenantKek(TENANT);
    expect(h.transit.minVersion).toBe(2);
    const current = envelopeAt(h.store.secrets.get(SECRET)?.envelope);
    const retired = envelopeAt(h.store.versions.get(`${SECRET}/1`)?.envelope);
    expect(await readAs(h, current)).toBe('v2-secret');
    expect(await readAs(h, retired)).toBe('v1-secret');
  });

  it('audits one secret.rewrapped with the count, and counts the KEK rotation', async () => {
    const h = setup();
    await seed(h);
    await h.service.rotateTenantKek(TENANT);
    expect(h.audits).toEqual([
      {
        tenantId: TENANT,
        action: 'secret.rewrapped',
        metadata: { keyName: `tenant-${TENANT}`, version: 2, count: 1 },
      },
    ]);
    expect(h.metrics.kekRotation).toEqual(['ok']);
    expect(h.metrics.rewrapped).toBe(1);
  });

  it('leaves an external-store secret untouched (no DEK to re-wrap)', async () => {
    const h = setup();
    await seed(h);
    await seed(h, {
      id: OTHER,
      backend: 'vault',
      envelope: null,
      externalLocator: { path: 'kv/x' },
    });
    await h.service.rotateTenantKek(TENANT);
    expect(h.store.saved.some((entry) => entry.includes(OTHER))).toBe(false);
    expect(h.store.secrets.get(OTHER)?.externalLocator).toEqual({ path: 'kv/x' });
  });

  it('re-wraps in batches, one keyset page at a time', async () => {
    const h = setup({ batchSize: 2 });
    for (let i = 0; i < 5; i += 1) {
      await seed(h, { id: randomUUID(), plaintext: `s${String(i)}` });
    }
    const result = await h.service.rotateTenantKek(TENANT);
    expect(result.rewrapped).toBe(5);
    // pages of 2, 2 and 1, then one empty page that ends the pass
    expect(h.store.batchCalls).toBe(4);
    expect(new Set(h.store.saved).size).toBe(5);
  });

  it('resumes after a crash mid-rewrap without re-wrapping finished rows or dropping any', async () => {
    const h = setup({ batchSize: 2 });
    for (let i = 0; i < 5; i += 1) {
      await seed(h, { id: randomUUID(), plaintext: `s${String(i)}` });
    }
    h.store.failSaveAttempt = 3;
    const error = await rejectionOf(h.service.rotateTenantKek(TENANT));
    expect(error).toMatchObject({ message: 'connection reset' });
    expect(h.metrics.rewrapError).toBe(1);
    // the floor was not raised, so both old and new ciphertext still decrypt
    expect(h.transit.minVersion).toBe(1);
    expect(h.store.saved).toHaveLength(2);
    for (const row of h.store.secrets.values()) {
      expect(await readAs(h, envelopeAt(row.envelope), row.id)).toMatch(/^s\d$/);
    }

    const resumed = await h.service.rewrapTenantKek(TENANT);
    expect(resumed).toMatchObject({ latestVersion: 2, minDecryptionVersion: 2, rewrapped: 3 });
    expect(new Set(h.store.saved).size).toBe(5);
    expect(h.store.remainingBelow(`tenant-${TENANT}`, 2)).toBe(0);
    const again = await h.service.rewrapTenantKek(TENANT);
    expect(again.rewrapped).toBe(0);
  });

  it('aborts with no state change when the KEK rotation fails (OpenBao down)', async () => {
    const h = setup();
    await seed(h);
    h.kek.rotateDown = true;
    await expect(h.service.rotateTenantKek(TENANT)).rejects.toMatchObject({
      code: 'KEK_UNAVAILABLE',
    });
    expect(h.store.saved).toEqual([]);
    expect(h.transit.minVersion).toBe(1);
    expect(h.audits).toEqual([]);
    expect(h.metrics.kekRotation).toEqual(['error']);
  });

  it('refuses to re-wrap a tenant whose KEK is disabled', async () => {
    const h = setup();
    await seed(h);
    h.kek.disabled = true;
    const error = await rejectionOf(h.service.rewrapTenantKek(TENANT));
    expect(error).toBeInstanceOf(EnvelopeError);
    expect(error).toMatchObject({ code: 'KEK_DISABLED' });
    expect(h.store.saved).toEqual([]);
  });

  it('never re-wraps another tenant envelope', async () => {
    const h = setup();
    await seed(h);
    await seed(h, { id: OTHER, tenantId: OTHER, plaintext: 'foreign' });
    await h.service.rotateTenantKek(TENANT);
    expect(h.store.secrets.get(OTHER)?.envelope?.kekVersion).toBe(1);
    expect(h.store.saved.some((entry) => entry.includes(OTHER))).toBe(false);
  });
});
