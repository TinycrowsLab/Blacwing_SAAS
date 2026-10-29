import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';

import { signEnvelope, verifyJws, type Ed25519Jwk, ed25519Jwk } from '@blackwing/crypto';
import { SodViolationError } from '@blackwing/domain/sod';
import { AppError } from '@blackwing/errors';
import { StandingAuthorisationId } from '@blackwing/ids';

import { createCursorCodec } from '../pagination/index.js';

import type {
  AssetVerifier,
  AuthorisationMemberships,
  EnvelopeSigner,
  StandingAuthorisationStore,
} from './ports.js';
import type { CreateStandingAuthorisationInput } from '@blackwing/contracts';
import type {
  NewStandingAuthorisation,
  StandingAuthorisationAuditEvent,
  StandingAuthorisationFields,
  StandingAuthorisationRecord,
  StandingAuthorisationWrite,
} from '@blackwing/db';

export const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
export const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
/** Org admin of tenant A: holds sa:read and sa:create. */
export const ADMIN_A = '0198f0a0-0000-7000-8000-0000000000a1';
/** Auditor of tenant A: reads only. */
export const AUDITOR_A = '0198f0a0-0000-7000-8000-0000000000a2';
/** Appsec engineer of tenant A: the requester of the drafts (sa:create, RBAC-001). */
export const APPSEC_A = '0198f0a0-0000-7000-8000-0000000000a3';
/** A second appsec engineer of tenant A: not the requester, so refused on the requester-only rules. */
export const APPSEC2_A = '0198f0a0-0000-7000-8000-0000000000a4';
/** Org admin of tenant B: the other tenant. */
export const ADMIN_B = '0198f0a0-0000-7000-8000-0000000000b1';
/** Appsec engineer of tenant B: holds sa:create in the other tenant, so cross-tenant reads reach the row check. */
export const APPSEC_B = '0198f0a0-0000-7000-8000-0000000000b3';
/** Asset owner of tenant A: the approver (sa:approve, RBAC-001). Not the requester of the drafts. */
export const APPROVER_A = '0198f0a0-0000-7000-8000-0000000000a5';
/** A second asset owner of tenant A, who requests an SA of their own (the separation-of-duties case). */
export const OWNER_A = '0198f0a0-0000-7000-8000-0000000000a6';

/** Two verified assets of tenant A, one of tenant B, and one unverified asset of tenant A. */
export const ASSET_A1 = '0198f0a0-0000-7000-8000-0000000000e1';
export const ASSET_A2 = '0198f0a0-0000-7000-8000-0000000000e2';
export const ASSET_B1 = '0198f0a0-0000-7000-8000-0000000000f1';
export const ASSET_A_UNVERIFIED = '0198f0a0-0000-7000-8000-0000000000e3';

const BASE_TIME = Date.parse('2026-10-29T10:00:00.000Z');
const STEP_MS = 1000;

/** A valid draft body as the API receives it (ISO strings, the wire shape). */
export function draftBody(
  overrides: Partial<CreateStandingAuthorisationInput> = {},
): CreateStandingAuthorisationInput {
  return {
    assetIds: [ASSET_A1],
    scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
    maxIntrusiveness: 'active_safe',
    preApprovedTestClasses: ['header-audit'],
    defaultBudgets: { costCapUsd: 5, maxRequests: 1000, maxDurationMs: 3_600_000 },
    testWindows: [{ cron: '0 2 * * 1-5', timezone: 'Europe/Berlin', durationMs: 7_200_000 }],
    validFrom: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A stored row as the Postgres adapter returns it, with defaults for every column. */
function rowOf(overrides: Partial<StandingAuthorisationRecord> = {}): StandingAuthorisationRecord {
  const id = overrides.id ?? StandingAuthorisationId.toUuid(StandingAuthorisationId.generate());
  return {
    id,
    tenantId: TENANT_A,
    publicId: StandingAuthorisationId.fromUuid(id),
    assetIds: [ASSET_A1],
    scopeRules: { rules: [{ effect: 'include', host: 'app.example.test' }] },
    maxIntrusiveness: 'active_safe',
    preApprovedTestClasses: ['header-audit'],
    defaultBudgets: { costCapUsd: 5, maxRequests: 1000, maxDurationMs: 3_600_000 },
    testWindows: [{ cron: '0 2 * * 1-5', timezone: 'Europe/Berlin', durationMs: 7_200_000 }],
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    requesterId: APPSEC_A,
    approverId: null,
    signature: null,
    signingKeyId: null,
    envelopeHash: null,
    version: 1,
    status: 'draft',
    revocationReason: null,
    createdAt: new Date(BASE_TIME),
    updatedAt: new Date(BASE_TIME),
    ...overrides,
  };
}

/** The caller-set fields as a stored row holds them: arrays are mutable copies. */
function recordFields(
  fields: Partial<StandingAuthorisationFields>,
): Partial<StandingAuthorisationRecord> {
  const { assetIds, preApprovedTestClasses, testWindows, ...rest } = fields;
  return {
    ...rest,
    ...(assetIds === undefined ? {} : { assetIds: [...assetIds] }),
    ...(preApprovedTestClasses === undefined
      ? {}
      : { preApprovedTestClasses: [...preApprovedTestClasses] }),
    ...(testWindows === undefined ? {} : { testWindows: [...testWindows] }),
  };
}

/** A gate decision the store recorded: Gate 1 on an SA, with its decider and reason (the `gate_decisions` row). */
interface RecordedDecision {
  readonly saId: string;
  readonly decision: 'approved' | 'rejected';
  readonly actorId: string;
  readonly reason: string | null;
}

export interface MemoryStore extends StandingAuthorisationStore {
  readonly rows: Map<string, StandingAuthorisationRecord>;
  readonly audits: StandingAuthorisationAuditEvent[];
  readonly decisions: RecordedDecision[];
}

/**
 * In-memory store with the contract of the Postgres adapter: tenant-filtered reads, a conditional write
 * on `version` that bumps it, and an audit event per committed change.
 */
export function memoryStore(initial: readonly StandingAuthorisationRecord[] = []): MemoryStore {
  const rows = new Map(initial.map((row) => [row.id, row]));
  const audits: StandingAuthorisationAuditEvent[] = [];
  const decisions: RecordedDecision[] = [];
  let tick = 0;
  const stamp = () => {
    tick += 1;
    return new Date(BASE_TIME + tick * STEP_MS);
  };
  return {
    rows,
    audits,
    decisions,
    insertDraft(tenantId: string, draft: NewStandingAuthorisation, audit) {
      const row = rowOf({
        ...recordFields(draft),
        id: draft.id,
        publicId: draft.publicId,
        requesterId: draft.requesterId,
        tenantId,
        status: 'draft',
        version: 1,
        createdAt: stamp(),
        updatedAt: stamp(),
      });
      rows.set(row.id, row);
      audits.push({ ...audit, tenantId });
      return Promise.resolve(row);
    },
    read(tenantId: string, id: string) {
      const row = rows.get(id);
      return Promise.resolve(row?.tenantId === tenantId ? row : undefined);
    },
    list(tenantId: string, options: { readonly afterId?: string; readonly limit: number }) {
      const sorted = [...rows.values()]
        .filter(
          (row) =>
            row.tenantId === tenantId &&
            (options.afterId === undefined || row.id > options.afterId),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return Promise.resolve(sorted.slice(0, options.limit + 1));
    },
    writeIf(
      tenantId: string,
      id: string,
      expectedVersion: number,
      write: StandingAuthorisationWrite,
      audit,
    ) {
      const current = rows.get(id);
      if (current?.tenantId !== tenantId || current.version !== expectedVersion) {
        return Promise.resolve(undefined);
      }
      // The Postgres adapter's gate row enforces separation of duties too: the same refusal, the same rollback.
      if (
        write.decision?.decision === 'approved' &&
        write.decision.actorId === current.requesterId
      ) {
        return Promise.reject(new SodViolationError('requester_equals_approver', 'gate1.approve'));
      }
      const next: StandingAuthorisationRecord = {
        ...current,
        ...recordFields(write.fields),
        ...(write.status === undefined ? {} : { status: write.status }),
        ...(write.approval === undefined
          ? {}
          : {
              approverId: write.approval.approverId,
              signature: write.approval.signature,
              signingKeyId: write.approval.signingKeyId,
              envelopeHash: write.approval.envelopeHash,
            }),
        version: current.version + 1,
        updatedAt: stamp(),
      };
      rows.set(id, next);
      audits.push({ ...audit, tenantId });
      if (write.decision !== undefined) {
        decisions.push({
          saId: id,
          decision: write.decision.decision,
          actorId: write.decision.actorId,
          reason: write.decision.reason,
        });
      }
      return Promise.resolve(next);
    },
  };
}

/** Verifies assets per tenant: anything not listed as verified is unverified (unknown or cross-tenant too). */
function memoryAssets(
  verified: Record<string, readonly string[]>,
): AssetVerifier & { readonly calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    unverified: (tenantId, assetIds) => {
      state.calls += 1;
      const ok = new Set(verified[tenantId] ?? []);
      return Promise.resolve(assetIds.filter((id) => !ok.has(id)));
    },
  };
}

/** Roles per (tenant, user). Anyone not listed holds no membership in that tenant. */
function memoryMemberships(
  roles: Record<string, Record<string, readonly string[]>>,
): AuthorisationMemberships {
  return {
    rolesOf: (tenantId, userId) => Promise.resolve(roles[tenantId]?.[userId] ?? []),
  };
}

/** The default verified-asset and membership fixtures shared by the unit and HTTP tests. */
export function standardFixtures() {
  return {
    assets: memoryAssets({ [TENANT_A]: [ASSET_A1, ASSET_A2], [TENANT_B]: [ASSET_B1] }),
    memberships: memoryMemberships({
      [TENANT_A]: {
        [ADMIN_A]: ['org_admin'],
        [AUDITOR_A]: ['auditor'],
        [APPSEC_A]: ['appsec_engineer'],
        [APPSEC2_A]: ['appsec_engineer'],
        [APPROVER_A]: ['asset_owner'],
        [OWNER_A]: ['asset_owner'],
      },
      [TENANT_B]: { [ADMIN_B]: ['org_admin'], [APPSEC_B]: ['appsec_engineer'] },
    }),
  };
}

/** The instant every approval test runs at: epoch milliseconds, the start of the test clock. */
export const APPROVAL_NOW_MS = Date.parse('2026-11-02T09:00:00.000Z');

/** The signing key of the test signer: its kid is the `<key>:v<N>` form the real signer produces. */
const TEST_SIGNING_KID = 'bw-sa-signing:v1';
const ED25519_PUBLIC_KEY_BYTES = 32;
const MS_PER_S = 1000;

export interface TestSigner {
  /** The port the service calls: a real Ed25519 detached JWS over the canonical bytes. */
  readonly signer: EnvelopeSigner;
  /** Verifies a stored `signature` against the canonical bytes the envelope signed (what the gateway will do). */
  verify(signature: string, canonicalBytes: Uint8Array): boolean;
  readonly jwk: Ed25519Jwk;
  readonly calls: { readonly saId: string; readonly tenantId: string }[];
}

/** An Ed25519 signer over a fresh key. It records each call, so tests can see what was signed and for whom. */
export function testSigner(): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawPublic = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-ED25519_PUBLIC_KEY_BYTES);
  const jwk = ed25519Jwk(TEST_SIGNING_KID, new Uint8Array(rawPublic));
  const calls: { saId: string; tenantId: string }[] = [];
  const keyOf = (kid: string): KeyObject | undefined =>
    kid === TEST_SIGNING_KID ? publicKey : undefined;
  return {
    calls,
    jwk,
    signer: {
      async signEnvelope({ tenantId, saId, canonicalBytes }) {
        calls.push({ saId, tenantId });
        const signed = await signEnvelope(
          canonicalBytes,
          {
            kid: TEST_SIGNING_KID,
            sign: (input) => Promise.resolve(new Uint8Array(edSign(null, input, privateKey))),
          },
          Math.floor(APPROVAL_NOW_MS / MS_PER_S),
        );
        return {
          signature: signed.compact,
          signingKeyId: signed.kid,
          envelopeHash: signed.envelopeHash,
        };
      },
    },
    verify(signature, canonicalBytes) {
      // The detached compact form carries no payload: re-attach the canonical bytes, then verify the whole token.
      const [header, , sig] = signature.split('.');
      if (header === undefined || sig === undefined) return false;
      const payload = Buffer.from(canonicalBytes).toString('base64url');
      return verifyJws(`${header}.${payload}.${sig}`, keyOf) !== null;
    },
  };
}

/** A signer that is down: every call fails the way an unreachable OpenBao does (AUTHZ_SIGNER_UNAVAILABLE). */
export function downSigner(): EnvelopeSigner {
  return {
    signEnvelope: () =>
      Promise.reject(
        new AppError('AUTHZ_SIGNER_UNAVAILABLE', 'the signing key service is unavailable', {
          detail: 'The signer is unavailable; nothing was signed.',
        }),
      ),
  };
}

/** A cursor codec with a valid-length test secret. */
export const testCursors = () => createCursorCodec('test-cursor-secret-0123456789abcdef');
