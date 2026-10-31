import {
  ConcurrencyError,
  type FindingRow,
  type FindingTriageRequest,
  type FindingTriageResult,
} from '@blackwing/db';
import {
  type TriageAuditIntent,
  type TriageCanonicalFacts,
  type TriageFindingFacts,
  transitionFinding,
} from '@blackwing/domain';
import { NotFoundError } from '@blackwing/errors';

import type { TriageStore } from './ports.js';
import type { Severity } from '@blackwing/contracts';

/** A scored severity: the release precondition (TRIAGE-001) needs one. */
export const SCORED: Severity = {
  cvss4: {
    vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N',
    score: 8.7,
    severity: 'high',
    nomenclature: 'CVSS-B',
  },
};

export interface MemoryTriageStore extends TriageStore {
  /** Every audit intent a committed decision wrote, with its tenant. A refusal writes none. */
  readonly audits: (TriageAuditIntent & { readonly tenantId: string })[];
  /** Every transition the store was asked to apply, refused or not. */
  readonly calls: FindingTriageRequest[];
  /** The current row of a finding, as the store holds it. */
  row(id: string): FindingRow | undefined;
}

/**
 * In-memory Gate 3 store with the contract of `FindingTriageRepository`: the same guards (`transitionFinding`, the real
 * domain function), the `state_version` compare-and-set, tenant isolation (another tenant's row is absent) and the audit
 * intents. `tenantOf()` stands in for the ambient RLS context. Every finding is of one asset class, so every duplicate
 * target is in class; `evidenceBound` says whether the findings have bound evidence.
 */
export function memoryTriageStore(
  rows: readonly FindingRow[],
  tenantOf: () => string,
  options: { readonly evidenceBound?: boolean } = {},
): MemoryTriageStore {
  const byId = new Map(rows.map((row) => [row.id, { ...row }]));
  const audits: MemoryTriageStore['audits'] = [];
  const calls: FindingTriageRequest[] = [];
  const own = (tenantId: string, id: string) => {
    const row = byId.get(id);
    return row?.tenantId === tenantId && tenantOf() === tenantId ? row : undefined;
  };

  /** The guarded change, applied synchronously: throws a refusal before anything is written. */
  const apply = (tenantId: string, request: FindingTriageRequest): FindingTriageResult => {
    calls.push(request);
    const row = own(tenantId, request.findingId);
    if (row === undefined) throw new NotFoundError('finding not found');
    if (row.stateVersion !== request.expectedStateVersion) throw new ConcurrencyError('finding');
    const facts: TriageFindingFacts = {
      id: row.id,
      status: row.status,
      stateVersion: row.stateVersion,
      assetType: 'web_app',
      scored: row.severity !== null,
      evidenceBound: options.evidenceBound ?? true,
      hasDuplicates: [...byId.values()].some(
        (other) => other.tenantId === tenantId && other.duplicateOf === row.id,
      ),
    };
    const canonicalRow =
      request.canonicalFindingId === undefined
        ? undefined
        : own(tenantId, request.canonicalFindingId);
    const canonical: TriageCanonicalFacts | null | undefined =
      request.canonicalFindingId === undefined
        ? undefined
        : canonicalRow === undefined
          ? null
          : { id: canonicalRow.id, status: canonicalRow.status, assetType: 'web_app' };
    const { next, auditIntent } = transitionFinding(
      facts,
      {
        to: request.to,
        actorId: request.actorId,
        reason: request.reason,
        now: request.now,
        expiresAt: request.expiresAt,
        canonicalFindingId: request.canonicalFindingId,
      },
      canonical,
    );
    const written: FindingRow = {
      ...row,
      status: next.status,
      stateVersion: next.stateVersion,
      acceptedRisk: next.acceptedRisk,
      duplicateOf: next.duplicateOf,
      releasedBy: next.releasedBy,
      releasedAt: next.releasedAt,
      updatedAt: request.now,
    };
    byId.set(row.id, written);
    audits.push({ ...auditIntent, tenantId });
    return { row: written, from: auditIntent.from };
  };

  return {
    audits,
    calls,
    row: (id) => byId.get(id),
    transition: (tenantId, request) => Promise.resolve().then(() => apply(tenantId, request)),
  };
}
