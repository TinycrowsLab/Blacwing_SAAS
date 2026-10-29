import { canTransitionAssessmentRequest, type AssessmentRequestStatus } from '@blackwing/contracts';
import { ConcurrencyError, type AssessmentRequestRow } from '@blackwing/db';
import { getTenantContextOrThrow } from '@blackwing/db/tenant-context';
import { ConflictError, NotFoundError } from '@blackwing/errors';
import { newId, toPublicId } from '@blackwing/ids';

import type {
  AssessmentRequestStore,
  AssetCatalog,
  AssetFact,
  StandingAuthorisationFact,
  StandingAuthorisationReader,
  AssessmentRequestMemberships,
  TenantHaltState,
} from './ports.js';

/** The owner of every fixture asset. The appsec engineers of the fixtures may act on it (Cedar, `policy.ts`). */
export const ASSET_OWNER = '0198f0a0-0000-7000-8000-0000000000a9';
export const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
export const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
export const ADMIN_A = '0198f0a0-0000-7000-8000-0000000000a1';
export const AUDITOR_A = '0198f0a0-0000-7000-8000-0000000000a2';
export const ADMIN_B = '0198f0a0-0000-7000-8000-0000000000b1';

export const ASSET_VERIFIED_A = '0198f0a0-0000-7000-8000-0000000000e1';
export const ASSET_UNVERIFIED_A = '0198f0a0-0000-7000-8000-0000000000e2';
export const ASSET_VERIFIED_B = '0198f0a0-0000-7000-8000-0000000000e3';

export const SA_A = '0198f0a0-0000-7000-8000-0000000000f1';
export const SA_EXPIRED_A = '0198f0a0-0000-7000-8000-0000000000f2';
export const SA_B = '0198f0a0-0000-7000-8000-0000000000f3';

/** The fixed clock of the submit gate. */
export const NOW = new Date('2026-10-29T10:00:00.000Z');

/** Spacing of the fake clock between writes, in milliseconds. */
const STEP_MS = 1000;

/** A scope rule the standing authorisation grants and a request may name. */
export const GRANTED_RULE = { effect: 'include', host: 'app.example.test' } as const;

/** Tenant-scoped in-memory request store with the repository's contract (ambient tenant, versioned writes). */
export function memoryAssessmentStore(): AssessmentRequestStore & {
  readonly rows: Map<string, AssessmentRequestRow>;
} {
  const rows = new Map<string, AssessmentRequestRow>();
  const tenantId = (): string => getTenantContextOrThrow().tenantId;
  const owned = (id: string): AssessmentRequestRow | undefined => {
    const row = rows.get(id);
    return row?.tenantId === tenantId() ? row : undefined;
  };
  let tick = 0;
  const bump = (
    row: AssessmentRequestRow,
    patch: Partial<AssessmentRequestRow>,
  ): AssessmentRequestRow => {
    tick += 1;
    return {
      ...row,
      ...patch,
      stateVersion: row.stateVersion + 1,
      updatedAt: new Date(NOW.getTime() + tick * STEP_MS),
    };
  };
  return {
    rows,
    create(input) {
      const id = newId();
      tick += 1;
      const row: AssessmentRequestRow = {
        id,
        tenantId: tenantId(),
        publicId: toPublicId(id, 'areq'),
        mode: input.mode,
        objective: input.objective,
        assetIds: input.assetIds === undefined ? [] : input.assetIds.map(String),
        saId: input.saId ?? null,
        inputManifestId: input.inputManifestId ?? null,
        scopeRules: { ...(input.scopeRules as Record<string, unknown>) },
        maxIntrusiveness: input.maxIntrusiveness,
        budgets: { ...(input.budgets as Record<string, unknown>) },
        trigger: input.trigger,
        status: 'draft',
        requestedBy: input.requestedBy,
        createdAt: new Date(NOW.getTime() + tick * STEP_MS),
        updatedAt: new Date(NOW.getTime() + tick * STEP_MS),
        stateVersion: 0,
      };
      rows.set(id, row);
      return Promise.resolve(row);
    },
    findById(id) {
      return Promise.resolve(owned(id));
    },
    list() {
      return Promise.resolve(
        [...rows.values()]
          .filter((r) => r.tenantId === tenantId())
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      );
    },
    updateDraft(id, expectedStateVersion, patch) {
      const row = owned(id);
      if (row === undefined)
        return Promise.reject(new NotFoundError('assessment request not found'));
      if (row.status !== 'draft')
        return Promise.reject(new ConflictError('assessment request is no longer a draft'));
      if (row.stateVersion !== expectedStateVersion)
        return Promise.reject(new ConcurrencyError('assessment request'));
      const next = bump(row, {
        ...(patch.mode === undefined ? {} : { mode: patch.mode }),
        ...(patch.objective === undefined ? {} : { objective: patch.objective }),
        ...(patch.assetIds === undefined ? {} : { assetIds: [...patch.assetIds] }),
        ...(patch.saId === undefined ? {} : { saId: patch.saId ?? null }),
        ...(patch.inputManifestId === undefined
          ? {}
          : { inputManifestId: patch.inputManifestId ?? null }),
        ...(patch.scopeRules === undefined
          ? {}
          : { scopeRules: { ...(patch.scopeRules as Record<string, unknown>) } }),
        ...(patch.maxIntrusiveness === undefined
          ? {}
          : { maxIntrusiveness: patch.maxIntrusiveness }),
        ...(patch.budgets === undefined
          ? {}
          : { budgets: { ...(patch.budgets as Record<string, unknown>) } }),
        ...(patch.trigger === undefined ? {} : { trigger: patch.trigger }),
      });
      rows.set(id, next);
      return Promise.resolve(next);
    },
    transition(id, expectedStateVersion, to: AssessmentRequestStatus) {
      const row = owned(id);
      if (row === undefined)
        return Promise.reject(new NotFoundError('assessment request not found'));
      if (row.stateVersion !== expectedStateVersion)
        return Promise.reject(new ConcurrencyError('assessment request'));
      if (!canTransitionAssessmentRequest(row.status, to)) {
        return Promise.reject(
          new ConflictError(`assessment request cannot move from ${row.status} to ${to}`),
        );
      }
      const next = bump(row, { status: to });
      rows.set(id, next);
      return Promise.resolve(next);
    },
  };
}

/** Assets per tenant. Lookups are tenant-scoped: a foreign tenant's asset is absent. */
export function memoryAssets(
  byTenant: Record<string, Record<string, AssetFact['verificationStatus']>>,
): AssetCatalog {
  return {
    findInTenant(tenantId, assetIds) {
      const assets = byTenant[tenantId] ?? {};
      const found: AssetFact[] = [];
      for (const id of assetIds) {
        const status = assets[id];
        if (status !== undefined)
          found.push({ id, verificationStatus: status, ownerUserId: ASSET_OWNER });
      }
      return Promise.resolve(found);
    },
  };
}

/** Standing authorisations keyed by `tenant:sa`. */
export function memoryStandingAuthorisations(
  byKey: Record<string, StandingAuthorisationFact>,
): StandingAuthorisationReader {
  return {
    findInTenant: (tenantId, saId) => Promise.resolve(byKey[`${tenantId}:${saId}`]),
  };
}

export function memoryMemberships(
  roles: Record<string, Record<string, readonly string[]>>,
): AssessmentRequestMemberships {
  return { rolesOf: (tenantId, userId) => Promise.resolve(roles[tenantId]?.[userId] ?? []) };
}

export function memoryHalts(halted: Set<string>): TenantHaltState {
  return { isHalted: (tenantId) => Promise.resolve(halted.has(tenantId)) };
}

/** A standing authorisation that covers both verified assets of tenant A, active until 2027. */
export function activeSaA(): StandingAuthorisationFact {
  return {
    id: SA_A,
    status: 'active',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    assetIds: [ASSET_VERIFIED_A, ASSET_UNVERIFIED_A],
    scopeRules: { rules: [GRANTED_RULE] },
    maxIntrusiveness: 'active_safe',
    defaultBudgets: { costCapUsd: 10, maxRequests: 10_000, maxDurationMs: 7_200_000 },
  };
}
