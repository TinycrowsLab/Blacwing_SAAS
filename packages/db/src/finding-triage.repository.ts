// Tenant-scoped triage of confirmed findings (TRIAGE-001, CONTEXT_PACK §3.4, §7, §8.4, §8.6, §8.8). The guards are pure
// (`transitionFinding` in `@blackwing/domain`); this class loads the facts they read, applies the result and writes the
// Gate 3 decision and its audit event in the same `withTenant` transaction, so a refused or failed step changes nothing.
// The state change is a compare-and-set on `state_version`: two writers that both read version N cannot both win, and
// the loser gets `ConcurrencyError` instead of a second release.

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { LIMITS, uuidV7Schema } from '@blackwing/contracts';
import {
  type TriageAuditIntent,
  type TriageCanonicalFacts,
  type TriageFindingFacts,
  TRIAGE_TARGETS,
  TRIAGE_TRANSITION_METRIC,
  type TriageTarget,
  transitionFinding,
  recordGateDecision,
} from '@blackwing/domain';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@blackwing/errors';

import { ConcurrencyError } from './repository.js';
import { toTenantIsolationError } from './rls.js';
import { assets } from './schema/assets.js';
import { authzGateDecisions } from './schema/authz-gate-decisions.js';
import { findingOccurrences, findings } from './schema/findings.js';
import { unwrapQueryError, type TenantTx, withTenant } from './with-tenant.js';

import type { Database } from './client.js';
import type { FindingRow } from './finding.repository.js';
import type { DbLogger } from './pool.js';
import type { GateDecisionAuditHook } from './standing-authorisation.repository.js';

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

/** The audit event a triage transition writes, with the tenant it belongs to (§8.8). */
export type FindingTriageAuditHook = (
  event: TriageAuditIntent & { readonly tenantId: string },
  tx: TenantTx,
) => void | Promise<void>;

/** Counter port for `triage_transition_total{to}`. */
interface TriageMetricSink {
  increment(name: string, labels: Readonly<Record<string, string>>): void;
}

export interface FindingTriageRepositoryOptions {
  readonly db: Database;
  /** Appends `finding.released|rejected|marked_duplicate|risk_accepted` inside the transition's transaction. */
  readonly audit: FindingTriageAuditHook;
  /** Appends `authz.gate.decision` inside the transition's transaction (the Gate 3 row's audit). */
  readonly gateAudit: GateDecisionAuditHook;
  readonly metrics?: TriageMetricSink;
  readonly logger?: Pick<DbLogger, 'info'>;
}

/**
 * One triage request. Parsed at the boundary: the tenant is the ambient one, never an input. `expectedStateVersion`
 * is the version the caller reviewed; a finding that moved on is a `ConcurrencyError` (412), not a silent overwrite.
 */
const requestSchema = z.strictObject({
  findingId: uuidV7Schema,
  expectedStateVersion: z.number().int().min(0).max(LIMITS.int32Max),
  to: z.enum(TRIAGE_TARGETS),
  actorId: uuidV7Schema,
  reason: z.string().max(LIMITS.reasonMax),
  expiresAt: z.string().max(LIMITS.shortTextMax).optional(),
  canonicalFindingId: z.string().max(LIMITS.shortTextMax).optional(),
  now: z.date(),
});
export interface FindingTriageRequest {
  readonly findingId: string;
  readonly expectedStateVersion: number;
  readonly to: TriageTarget;
  readonly actorId: string;
  readonly reason: string;
  /** Required for `accepted_risk`: an offset-bearing ISO-8601 instant, in the future (checked by the guard). */
  readonly expiresAt?: string;
  /** Required for `duplicate`: the canonical finding's id. */
  readonly canonicalFindingId?: string;
  /** The caller's clock. */
  readonly now: Date;
}

export interface FindingTriageResult {
  readonly row: FindingRow;
  /** The status the finding moved from (always `confirmed`). */
  readonly from: string;
}

function parseRequest(value: unknown): z.output<typeof requestSchema> {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    // Field paths only: issue messages can echo input values.
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ValidationError('invalid triage request', {
      detail: `Invalid triage request: ${[...new Set(fields)].join(', ')}.`,
    });
  }
  return parsed.data;
}

/** Tenant-scoped triage of findings. */
export class FindingTriageRepository {
  private readonly options: FindingTriageRepositoryOptions;

  constructor(options: FindingTriageRepositoryOptions) {
    this.options = options;
  }

  /**
   * Applies one triage decision to a finding of `tenantId`. Refusals (illegal status, blank reason, bad expiry or
   * canonical, unmet release precondition) throw the domain errors and write nothing. A finding that is not visible in
   * the tenant is `NotFoundError`; a stale `expectedStateVersion`, or a concurrent writer that won, is `ConcurrencyError`.
   */
  async transition(tenantId: string, request: FindingTriageRequest): Promise<FindingTriageResult> {
    const input = parseRequest(request);
    try {
      const result = await withTenant(this.options.db, tenantId, async (tx) => {
        const [row] = await tx
          .select()
          .from(findings)
          .where(and(eq(findings.tenantId, tenantId), eq(findings.id, input.findingId)))
          .limit(1);
        if (row === undefined) throw new NotFoundError('finding not found');
        if (row.stateVersion !== input.expectedStateVersion) throw new ConcurrencyError('finding');

        const facts = await this.loadFacts(tx, tenantId, row);
        const canonical =
          input.canonicalFindingId === undefined
            ? undefined
            : await this.loadCanonical(tx, tenantId, input.canonicalFindingId);

        const { next, gate, auditIntent } = transitionFinding(
          facts,
          {
            to: input.to,
            actorId: input.actorId,
            reason: input.reason,
            now: input.now,
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            ...(input.canonicalFindingId === undefined
              ? {}
              : { canonicalFindingId: input.canonicalFindingId }),
          },
          canonical,
        );

        // Compare-and-set on the version and the status the guards read: a racing writer that committed first makes
        // this match zero rows, and nothing below runs.
        const [written] = await tx
          .update(findings)
          .set({
            status: next.status,
            stateVersion: sql`${findings.stateVersion} + 1`,
            acceptedRisk: next.acceptedRisk,
            duplicateOf: next.duplicateOf,
            releasedBy: next.releasedBy,
            releasedAt: next.releasedAt,
          })
          .where(
            and(
              eq(findings.tenantId, tenantId),
              eq(findings.id, row.id),
              eq(findings.stateVersion, input.expectedStateVersion),
              eq(findings.status, 'confirmed'),
            ),
          )
          .returning();
        if (written === undefined) throw new ConcurrencyError('finding');

        await recordGateDecision(
          {
            insert: async (decision) => {
              await tx.insert(authzGateDecisions).values({ ...decision, tenantId });
            },
            audit: async (event) => {
              await this.options.gateAudit(event, tx);
            },
          },
          gate,
        );
        await this.options.audit({ ...auditIntent, tenantId }, tx);
        return { row: written, from: auditIntent.from };
      });
      this.options.metrics?.increment(TRIAGE_TRANSITION_METRIC, { to: input.to });
      this.options.logger?.info(
        {
          entity: 'finding',
          op: 'triage',
          findingPublicId: result.row.publicId,
          from: result.from,
          to: input.to,
          actorId: input.actorId,
          auto: false,
        },
        'finding.triage',
      );
      return result;
    } catch (error) {
      throw translate(error);
    }
  }

  /** The facts the guards read, for a finding row the caller already holds in the transaction. */
  private async loadFacts(
    tx: TenantTx,
    tenantId: string,
    row: FindingRow,
  ): Promise<TriageFindingFacts> {
    const [asset] = await tx
      .select({ type: assets.type })
      .from(assets)
      .where(and(eq(assets.tenantId, tenantId), eq(assets.id, row.assetId)))
      .limit(1);
    const [incoming] = await tx
      .select({ id: findings.id })
      .from(findings)
      .where(and(eq(findings.tenantId, tenantId), eq(findings.duplicateOf, row.id)))
      .limit(1);
    // Evidence is bound per occurrence: a chain head recorded at detection (EVIDENCE, FINDING-001).
    const [bound] = await tx
      .select({ id: findingOccurrences.id })
      .from(findingOccurrences)
      .where(
        and(
          eq(findingOccurrences.tenantId, tenantId),
          eq(findingOccurrences.findingId, row.id),
          isNotNull(findingOccurrences.evidenceChainHead),
        ),
      )
      .limit(1);
    return {
      id: row.id,
      status: row.status,
      stateVersion: row.stateVersion,
      assetType: asset?.type ?? null,
      scored: row.severity !== null,
      evidenceBound: bound !== undefined,
      hasDuplicates: incoming !== undefined,
    };
  }

  /** The canonical finding named by a duplicate request, or `null` when it is not visible in this tenant. */
  private async loadCanonical(
    tx: TenantTx,
    tenantId: string,
    canonicalFindingId: string,
  ): Promise<TriageCanonicalFacts | null> {
    const [found] = await tx
      .select({ id: findings.id, status: findings.status, assetType: assets.type })
      .from(findings)
      .leftJoin(assets, and(eq(assets.tenantId, tenantId), eq(assets.id, findings.assetId)))
      .where(and(eq(findings.tenantId, tenantId), eq(findings.id, canonicalFindingId)))
      .limit(1);
    return found === undefined
      ? null
      : { id: found.id, status: found.status, assetType: found.assetType ?? null };
  }
}

/** A duplicate Gate 3 row (one approved decision per finding) is a conflict; a CHECK violation is invalid input. */
function translate(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const pgError = unwrapQueryError(error) as { code?: unknown };
  if (pgError.code === UNIQUE_VIOLATION) {
    return new ConflictError('finding already has a decision at this gate', { cause: error });
  }
  if (pgError.code === CHECK_VIOLATION) {
    return new ValidationError('invalid finding triage', {
      detail: 'A database check rejected the triage decision.',
      cause: error,
    });
  }
  return toTenantIsolationError(pgError) ?? error;
}
