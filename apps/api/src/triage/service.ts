import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import {
  type FindingTriageResponse,
  findingPublicIdSchema,
  type Permission,
} from '@blackwing/contracts';
import { hasPermission, type TriageTarget } from '@blackwing/domain';
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
} from '@blackwing/errors';
import { toUuid } from '@blackwing/ids';

import { currentTraceId } from '../bootstrap/request-context.js';
import { requireIfMatch, versionEtag } from '../concurrency/index.js';
import { summaryOf, type FindingService } from '../findings/service.js';

import type { TriageAction, TriageMetrics, TriageResult } from './metrics.js';
import type { TriageStore } from './ports.js';
import type { FindingMemberships } from '../findings/ports.js';
import type { FindingRow, FindingTriageRequest, FindingTriageResult } from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/triage';
const FINDING_ID_PREFIX = 'fnd';
const TRIAGE_PERMISSION: Permission = 'finding:triage';

/** The Gate 3 target each route decides (TRIAGE-001). */
const TARGET_OF: Readonly<Record<TriageAction, TriageTarget>> = Object.freeze({
  release: 'released',
  reject: 'rejected_false_positive',
  duplicate: 'duplicate',
  'accept-risk': 'accepted_risk',
});

/** The caller: the tenant the guard resolved and the user deciding in it. */
export interface TriagePrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

/** What a route passes on from its body. Only the fields the decision uses; the guards validate them (TRIAGE-001). */
export interface TriageDecision {
  readonly reason?: string | undefined;
  readonly expiry?: string | undefined;
  readonly canonicalFindingId?: string | undefined;
}

/** A decision's answer: the finding after the change and the ETag that validates it. */
export interface TriageView {
  readonly body: FindingTriageResponse;
  readonly etag: string;
}

export interface TriageServiceDeps {
  readonly store: TriageStore;
  /**
   * The finding read service (FINDING-001). Its `readable` checks RBAC `finding:read`, the Cedar rule (a Suspected
   * finding is visible to analysts only) and the tenant, and answers every hidden finding with the same `404`.
   */
  readonly findings: FindingService;
  readonly memberships: FindingMemberships;
  readonly metrics: TriageMetrics;
  readonly logger: Pick<Logger, 'info'>;
  /** The decision instant; defaults to the wall clock. */
  readonly now?: () => Date;
  /**
   * The TRIAGE-004 hook: the Gate 3 separation-of-duties check a release must pass before it is written. It throws to
   * refuse. Absent, no extra check runs; the hook is called in the same place either way.
   */
  readonly assertReleaseActor?: (
    principal: TriagePrincipal,
    finding: FindingRow,
  ) => void | Promise<void>;
  readonly tracer?: Tracer;
}

/** A refusal with a triage wire code. The detail is fixed text, never the caller's input. */
function refusal(code: AppError['code'], detail: string): AppError {
  return new AppError(code, detail, { detail });
}

/**
 * Maps the domain and persistence refusals to the triage wire codes of the API (the routes' problem+json `code`).
 * Anything else passes through unchanged, so its own status and code stay.
 */
function translate(error: unknown): unknown {
  if (!(error instanceof AppError)) return error;
  switch (error.code) {
    case 'PRECONDITION_FAILED':
      return refusal(
        'TRIAGE_CONCURRENCY',
        'The finding changed since it was read. Re-read it and decide again.',
      );
    case 'FINDING_ILLEGAL_TRANSITION':
      return refusal(
        'TRIAGE_INVALID_TRANSITION',
        'This decision is not allowed for the finding status.',
      );
    case 'TRIAGE_EXPIRY_INVALID':
      return refusal(
        'TRIAGE_RISK_EXPIRY_INVALID',
        'The accepted-risk expiry must be an ISO-8601 instant with an offset, in the future.',
      );
    case 'TRIAGE_CANONICAL_INVALID':
      return refusal(
        'TRIAGE_DUPLICATE_TARGET_INVALID',
        'The canonical finding must be another visible finding of the same asset class.',
      );
    default:
      return error;
  }
}

function resultOf(error: unknown): TriageResult {
  if (error instanceof ForbiddenError) return 'denied';
  if (error instanceof NotFoundError) return 'not_found';
  if (error instanceof AppError && error.code === 'TRIAGE_CONCURRENCY') return 'conflict';
  return 'refused';
}

/**
 * The Gate 3 decision service (TRIAGE-004 routes over TRIAGE-001). It owns the authorisation (RBAC `finding:triage` on top
 * of the finding read check), the `If-Match` precondition, the wire codes and the response. The transition itself, the
 * gate decision and the audit event are TRIAGE-001's, applied by the store in one transaction. Idempotency is the
 * `@Idempotent()` route guard: a replayed `Idempotency-Key` never reaches this service.
 */
export class TriageService {
  private readonly tracer: Tracer;

  constructor(private readonly deps: TriageServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  /** Decides one finding: `action` is the route. Missing, foreign and hidden findings are one `404` (from the read check). */
  async decide(
    principal: TriagePrincipal,
    action: TriageAction,
    publicId: string,
    ifMatch: string | undefined,
    decision: TriageDecision,
  ): Promise<TriageView> {
    return this.inSpan(`triage.${action}`, async (span) => {
      const started = performance.now();
      let result: TriageResult = 'refused';
      try {
        const view = await this.decideFinding(principal, action, publicId, ifMatch, decision, span);
        result = 'ok';
        return view;
      } catch (error) {
        result = resultOf(error);
        throw error;
      } finally {
        this.deps.metrics.decision(action, result, performance.now() - started);
      }
    });
  }

  private async decideFinding(
    principal: TriagePrincipal,
    action: TriageAction,
    publicId: string,
    ifMatch: string | undefined,
    decision: TriageDecision,
    span: Span,
  ): Promise<TriageView> {
    const row = await this.deps.findings.readable(principal, publicId);
    span.setAttribute('finding_id', row.publicId);
    const roles = await this.deps.memberships.rolesOf(principal.tenantId, principal.actorId);
    if (!hasPermission(roles, TRIAGE_PERMISSION)) {
      throw new ForbiddenError('the caller may not triage findings', {
        detail: `Missing permission ${TRIAGE_PERMISSION} in this tenant.`,
      });
    }
    const expectedStateVersion = this.expectedVersion(row, ifMatch);
    const canonicalFindingId =
      action === 'duplicate' ? this.canonicalId(decision.canonicalFindingId) : undefined;
    if (action === 'release') await this.deps.assertReleaseActor?.(principal, row);

    const request: FindingTriageRequest = {
      findingId: row.id,
      expectedStateVersion,
      to: TARGET_OF[action],
      actorId: principal.actorId,
      reason: decision.reason ?? '',
      now: this.deps.now?.() ?? new Date(),
      ...(decision.expiry === undefined ? {} : { expiresAt: decision.expiry }),
      ...(canonicalFindingId === undefined ? {} : { canonicalFindingId }),
    };
    let written: FindingTriageResult;
    try {
      written = await this.deps.store.transition(principal.tenantId, request);
    } catch (error) {
      throw translate(error);
    }
    this.deps.logger.info(
      {
        findingPublicId: row.publicId,
        action,
        actorId: principal.actorId,
        traceId: currentTraceId(),
        from: written.from,
        to: request.to,
      },
      'triage.decision',
    );
    return {
      body: { finding: summaryOf(written.row) },
      etag: versionEtag(written.row.stateVersion),
    };
  }

  /**
   * The version the decision was made against: from `If-Match` (`"vN"`, or `*` for "whatever it is now"). A missing or weak
   * header is `428`; a stale one is `TRIAGE_CONCURRENCY` (412), so the caller re-reads and decides again.
   */
  private expectedVersion(row: FindingRow, ifMatch: string | undefined): number {
    try {
      const check = requireIfMatch(versionEtag(row.stateVersion), ifMatch);
      return check.expectedVersion ?? row.stateVersion;
    } catch (error) {
      if (error instanceof PreconditionFailedError) {
        throw refusal(
          'TRIAGE_CONCURRENCY',
          'The finding changed since it was read. Re-read it and decide again.',
        );
      }
      throw error;
    }
  }

  /** The canonical finding of a duplicate: a `fnd_…` id, read as its row id. Anything else is refused as a bad target. */
  private canonicalId(publicId: string | undefined): string {
    const parsed = findingPublicIdSchema.safeParse(publicId ?? '');
    if (!parsed.success) {
      throw refusal(
        'TRIAGE_DUPLICATE_TARGET_INVALID',
        'A duplicate needs the canonical finding id.',
      );
    }
    try {
      return toUuid(parsed.data, FINDING_ID_PREFIX);
    } catch {
      throw refusal(
        'TRIAGE_DUPLICATE_TARGET_INVALID',
        'A duplicate needs the canonical finding id.',
      );
    }
  }

  private async inSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span: Span) => {
      try {
        return await fn(span);
      } catch (error) {
        if (!(error instanceof ForbiddenError) && !(error instanceof NotFoundError)) {
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
