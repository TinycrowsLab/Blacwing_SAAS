// Signed policy snapshot bundles (POLICY-007, CONTEXT_PACK §3.1, §8.2, §8.9). A snapshot is the tenant's effective
// policy set (platform baseline + active tenant version) plus the Cedar schema and its pins, as canonical JSON
// (RFC 8785, `@blackwing/crypto` `jcs`), signed as a compact Ed25519 JWS over OpenBao Transit. The Go egress gateway
// (EGRESS-003) loads, verifies and evaluates the bundle, so the signing and verification contract below is the
// shared spec (docs/architecture/policy-snapshot-format.md): alg `EdDSA`, `kid` resolved through the JWKS, and the
// payload is the canonical bytes of `PolicySnapshotBody`. The snapshot id is the SHA-256 of those canonical bytes.
// Snapshots are immutable: a new activation builds a new snapshot with a new id.
//
// This module holds the pure build and verify logic and the publish orchestration. Storage and signing are ports
// (`PolicySnapshotStore`, `PolicySnapshotObjectStore`, `EnvelopeSigningKey`), because the policy package may depend
// on contracts and shared libraries only (docs/architecture/dependency-graph.md). The db, secrets and evidence
// packages implement them structurally.

import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  canonicaliseValue,
  type Ed25519Jwk,
  type EnvelopeSigningKey,
  signCanonicalJws,
  verifyJws,
} from '@blackwing/crypto';

import { loadBaseline, type Baseline } from './baseline.js';
import { loadBlackwingSchema, SCHEMA_VERSION } from './schema.js';
import {
  assembleEffectivePolicySet,
  canonicalPolicySource,
  type EffectivePolicySet,
  type TenantPolicyVersionRef,
} from './tenant-policy.js';

/** The snapshot body format version. A verifier refuses any other value. */
export const POLICY_SNAPSHOT_FORMAT_VERSION = 1;

/** The protected-header `typ`: a snapshot token is never read as another kind of JWS (RFC 7515 §4.1.9). */
export const POLICY_SNAPSHOT_TYP = 'application/policy-snapshot+jcs';

/** A token larger than this is refused before parsing. The schema text dominates the size. */
export const POLICY_SNAPSHOT_MAX_BYTES = 8_388_608;

/** The signed payload. Keys are canonicalised (JCS), so the field set here is the whole contract. */
export interface PolicySnapshotBody {
  readonly snapshotVersion: typeof POLICY_SNAPSHOT_FORMAT_VERSION;
  readonly tenantId: string;
  /** ISO-8601 UTC instant the snapshot was built. */
  readonly builtAt: string;
  readonly schemaVersion: string;
  readonly cedarSchema: string;
  readonly baselineVersion: string;
  readonly baselineSha256: string;
  readonly tenantPolicyVersion: number | null;
  readonly tenantSha256: string | null;
  /** Layers in evaluation order: `baseline`, then `tenant` when a version is active. */
  readonly policies: readonly { readonly id: 'baseline' | 'tenant'; readonly source: string }[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** Zod boundary for a verified payload: anything outside this shape fails closed. */
export const policySnapshotBodySchema = z
  .object({
    snapshotVersion: z.literal(POLICY_SNAPSHOT_FORMAT_VERSION),
    tenantId: z.uuid(),
    builtAt: z.iso.datetime(),
    schemaVersion: z.string().min(1),
    cedarSchema: z.string().min(1),
    baselineVersion: z.string().min(1),
    baselineSha256: z.string().regex(SHA256_HEX),
    tenantPolicyVersion: z.number().int().min(1).nullable(),
    tenantSha256: z.string().regex(SHA256_HEX).nullable(),
    policies: z
      .array(z.object({ id: z.enum(['baseline', 'tenant']), source: z.string() }))
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((body, ctx) => {
    const tenantLayer = body.policies.some((p) => p.id === 'tenant');
    if (tenantLayer !== (body.tenantPolicyVersion !== null && body.tenantSha256 !== null)) {
      ctx.addIssue({ code: 'custom', message: 'tenant layer and tenant pins disagree' });
    }
    if (body.policies[0]?.id !== 'baseline' || body.policies.length !== (tenantLayer ? 2 : 1)) {
      ctx.addIssue({ code: 'custom', message: 'policy layers out of order or missing' });
    }
  });

/** Builds the body for one tenant from its effective set. Pure: the schema and baseline are read unless passed. */
export function buildPolicySnapshotBody(input: {
  readonly tenantId: string;
  readonly builtAt: Date;
  readonly effective: EffectivePolicySet;
  readonly cedarSchema?: string;
}): PolicySnapshotBody {
  const { effective } = input;
  const policies: { id: 'baseline' | 'tenant'; source: string }[] = [
    { id: 'baseline', source: effective.baseline.source },
  ];
  if (effective.tenant !== null) {
    policies.push({ id: 'tenant', source: effective.tenant.source });
  }
  return {
    snapshotVersion: POLICY_SNAPSHOT_FORMAT_VERSION,
    tenantId: input.tenantId,
    builtAt: input.builtAt.toISOString(),
    schemaVersion: SCHEMA_VERSION,
    cedarSchema: input.cedarSchema ?? loadBlackwingSchema(),
    baselineVersion: effective.baseline.version,
    baselineSha256: effective.baseline.sha256,
    tenantPolicyVersion: effective.tenant === null ? null : Number(effective.tenant.version),
    tenantSha256: effective.tenant?.sha256 ?? null,
    policies,
  };
}

/** The canonical bytes (RFC 8785) the signature and the snapshot id cover. */
export function policySnapshotCanonicalBytes(body: PolicySnapshotBody): Uint8Array {
  return canonicaliseValue(body);
}

/** Lowercase hex SHA-256 of the canonical bytes: the snapshot id (§8.9). */
export function policySnapshotId(canonicalBytes: Uint8Array): string {
  return createHash('sha256').update(canonicalBytes).digest('hex');
}

/** Signs the body as a compact attached JWS. The key is the Transit signing key (SECRETS / AUTHZ-004). */
export async function signPolicySnapshot(
  body: PolicySnapshotBody,
  key: EnvelopeSigningKey,
): Promise<{ readonly token: string; readonly snapshotId: string; readonly signingKeyId: string }> {
  const canonical = policySnapshotCanonicalBytes(body);
  const token = await signCanonicalJws(canonical, key, POLICY_SNAPSHOT_TYP);
  return { token, snapshotId: policySnapshotId(canonical), signingKeyId: key.kid };
}

/** Why a snapshot was refused. One stable reason per defect; the caller logs it and fails closed. */
export type PolicySnapshotVerifyFailure =
  | 'malformed'
  | 'wrong_type'
  | 'unknown_key'
  | 'bad_signature'
  | 'bad_body'
  | 'wrong_tenant'
  | 'tenant_digest_mismatch';

export type PolicySnapshotVerifyResult =
  | {
      readonly ok: true;
      readonly body: PolicySnapshotBody;
      readonly snapshotId: string;
      readonly kid: string;
    }
  | { readonly ok: false; readonly reason: PolicySnapshotVerifyFailure };

/**
 * Verifies a snapshot token against the public key set (the JWKS of the signing key, which keeps every key version
 * it has ever used, so a rotated key still verifies older snapshots). The checks are: JWS type and algorithm,
 * signature under the key named by `kid`, canonical payload, the body schema, the tenant when `expectedTenantId`
 * is given, and the tenant layer digest against the tenant source it carries. Fail closed: any defect is a refusal.
 */
export function verifyPolicySnapshot(
  token: string,
  jwks: { readonly keys: readonly Ed25519Jwk[] },
  expectedTenantId?: string,
): PolicySnapshotVerifyResult {
  const keys = new Map<string, KeyObject>();
  for (const jwk of jwks.keys) {
    keys.set(
      jwk.kid,
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }),
    );
  }
  const header = decodeHeader(token);
  if (header === undefined) return { ok: false, reason: 'malformed' };
  if (header.typ !== POLICY_SNAPSHOT_TYP) return { ok: false, reason: 'wrong_type' };
  if (header.kid === undefined || !keys.has(header.kid))
    return { ok: false, reason: 'unknown_key' };

  const verified = verifyJws(token, (kid) => keys.get(kid), POLICY_SNAPSHOT_MAX_BYTES);
  if (verified === null) return { ok: false, reason: 'bad_signature' };

  const parsed = policySnapshotBodySchema.safeParse(verified.payload);
  if (!parsed.success) return { ok: false, reason: 'bad_body' };
  const body = parsed.data as PolicySnapshotBody;
  if (expectedTenantId !== undefined && body.tenantId !== expectedTenantId) {
    return { ok: false, reason: 'wrong_tenant' };
  }
  const tenantLayer = body.policies.find((p) => p.id === 'tenant');
  if (tenantLayer !== undefined && policySourceDigest(tenantLayer.source) !== body.tenantSha256) {
    return { ok: false, reason: 'tenant_digest_mismatch' };
  }
  return {
    ok: true,
    body,
    snapshotId: policySnapshotId(policySnapshotCanonicalBytes(body)),
    kid: verified.kid,
  };
}

/** Reads the protected header without trusting it: `undefined` when it is not a JSON object. */
function decodeHeader(
  token: string,
): { readonly typ?: unknown; readonly kid?: string | undefined } | undefined {
  const first = token.split('.')[0];
  if (first === undefined || first === '') return undefined;
  try {
    const value = JSON.parse(Buffer.from(first, 'base64url').toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null) return undefined;
    const kid = (value as { kid?: unknown }).kid;
    return {
      typ: (value as { typ?: unknown }).typ,
      kid: typeof kid === 'string' ? kid : undefined,
    };
  } catch {
    return undefined;
  }
}

/** The tenant layer digest: SHA-256 over the canonical source (the same digest the policy table stores). */
function policySourceDigest(source: string): string {
  return createHash('sha256').update(canonicalPolicySource(source), 'utf8').digest('hex');
}

/** Where a snapshot's bytes live. Tenant-prefixed (`t/`), the only prefix the bucket policy allows (storage-buckets). */
export function policySnapshotObjectKey(tenantId: string, snapshotId: string): string {
  return `t/${tenantId}/policy-snapshots/${snapshotId}.jws`;
}

/** The row written for a published snapshot. The row exists only after its object was stored (publish order). */
export interface NewPolicySnapshotRecord {
  readonly tenantId: string;
  readonly snapshotSha256: string;
  readonly signingKeyId: string;
  readonly baselineVersion: string;
  readonly tenantPolicyVersion: number | null;
  readonly objectKey: string;
}

/** Persists the snapshot row (RLS-scoped in the db package, audited in the same transaction). */
export interface PolicySnapshotStore {
  insert(record: NewPolicySnapshotRecord): Promise<void>;
}

/** Stores the signed bundle bytes. A write that does not complete throws; nothing is recorded for it. */
export interface PolicySnapshotObjectStore {
  put(objectKey: string, bytes: Uint8Array): Promise<void>;
}

export interface PublishPolicySnapshotPorts {
  readonly signingKey: EnvelopeSigningKey;
  readonly store: PolicySnapshotStore;
  readonly objects: PolicySnapshotObjectStore;
  /** Attempts for the object write (not the signature: a signer failure is never retried). Default 3. */
  readonly objectWriteAttempts?: number;
  readonly now?: () => Date;
}

export interface PublishedPolicySnapshot {
  readonly snapshotId: string;
  readonly signingKeyId: string;
  readonly objectKey: string;
  readonly token: string;
  readonly body: PolicySnapshotBody;
}

const DEFAULT_OBJECT_WRITE_ATTEMPTS = 3;

const TRACER_NAME = '@blackwing/policy';
const meter = metrics.getMeter(TRACER_NAME);
const buildTotal = meter.createCounter('policy_snapshot_build_total', {
  description: 'Policy snapshot builds by result',
});
const buildSizeBytes = meter.createHistogram('policy_snapshot_build_size_bytes', {
  description: 'Signed policy snapshot size in bytes',
  unit: 'By',
});
const signFailures = meter.createCounter('policy_snapshot_sign_failures_total', {
  description: 'Policy snapshot signing failures (the snapshot is not published)',
});

/**
 * Builds, signs, stores and records the snapshot of a tenant's effective set (POLICY-007). Order: sign, store the
 * bytes, then record the row. A signing failure publishes nothing (fail closed: no unsigned snapshot is ever
 * stored); an object-store failure is retried and then surfaces, leaving the last good snapshot in use.
 */
export async function publishPolicySnapshot(
  input: {
    readonly tenantId: string;
    readonly activeVersion: TenantPolicyVersionRef | null;
    readonly baseline?: Baseline;
    readonly cedarSchema?: string;
  },
  ports: PublishPolicySnapshotPorts,
): Promise<PublishedPolicySnapshot> {
  return trace.getTracer(TRACER_NAME).startActiveSpan('policy.snapshot.build', async (span) => {
    try {
      const effective = assembleEffectivePolicySet(
        input.activeVersion,
        input.baseline ?? loadBaseline(),
      );
      const body = buildPolicySnapshotBody({
        tenantId: input.tenantId,
        builtAt: (ports.now ?? (() => new Date()))(),
        effective,
        ...(input.cedarSchema === undefined ? {} : { cedarSchema: input.cedarSchema }),
      });
      let signed: Awaited<ReturnType<typeof signPolicySnapshot>>;
      try {
        signed = await signPolicySnapshot(body, ports.signingKey);
      } catch (error) {
        signFailures.add(1);
        throw error;
      }
      const { token, snapshotId, signingKeyId } = signed;
      span.setAttribute('snapshotId', snapshotId);
      const objectKey = policySnapshotObjectKey(input.tenantId, snapshotId);
      const bytes = new TextEncoder().encode(token);
      await writeWithRetry(
        ports.objects,
        objectKey,
        bytes,
        ports.objectWriteAttempts ?? DEFAULT_OBJECT_WRITE_ATTEMPTS,
      );
      await ports.store.insert({
        tenantId: input.tenantId,
        snapshotSha256: snapshotId,
        signingKeyId,
        baselineVersion: body.baselineVersion,
        tenantPolicyVersion: body.tenantPolicyVersion,
        objectKey,
      });
      buildTotal.add(1, { result: 'ok' });
      buildSizeBytes.record(bytes.byteLength);
      return { snapshotId, signingKeyId, objectKey, token, body };
    } catch (error) {
      buildTotal.add(1, { result: 'error' });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function writeWithRetry(
  objects: PolicySnapshotObjectStore,
  objectKey: string,
  bytes: Uint8Array,
  attempts: number,
): Promise<void> {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError('objectWriteAttempts must be a positive integer');
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await objects.put(objectKey, bytes);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
