import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import {
  runBudgetsSchema,
  type RunBudget,
  type AssessmentRequestResponse,
  type CreateAssessmentRequest,
  type PatchAssessmentRequest,
  type Permission,
} from '@blackwing/contracts';
import { hashTenantId } from '@blackwing/db/tenant-context';
import { hasPermission } from '@blackwing/domain';
import { ForbiddenError, NotFoundError } from '@blackwing/errors';
import { toPublicId, toUuid } from '@blackwing/ids';

import { tenantHaltedError } from './errors.js';
import { checkSubmission, type SubmitFailure } from './submit-checks.js';
import { requireIfMatch, versionEtag } from '../concurrency/index.js';
import { FieldValidationError } from '../errors/problem-errors.js';

import type { AssessmentRequestMetrics } from './metrics.js';
import type { AssessmentPolicyEngine, AssessmentPolicyPrincipal } from './policy.js';
import type {
  AssessmentRequestMemberships,
  AssessmentRequestStore,
  AssetCatalog,
  AssetFact,
  StandingAuthorisationReader,
  TenantHaltState,
} from './ports.js';
import type {
  AssessmentRequestCreate,
  AssessmentRequestRow,
  AssessmentRequestUpdate,
} from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/assessment-requests';
const SUBMIT_SPAN = 'api.scope.submit';

/** Run budgets a request gets when it names none: the seed's standing defaults (SCOPE-004). */
const RUN_BUDGET_DEFAULTS: RunBudget = Object.freeze({
  costCapUsd: 5,
  maxRequests: 5_000,
  maxDurationMs: 3_600_000,
});

/** The run budget with the requested dimensions applied over `base`; a dimension left out keeps its base value. */
function withRunBudgets(
  base: RunBudget,
  overrides: { readonly [K in keyof RunBudget]?: number | undefined } | undefined,
): RunBudget {
  return {
    costCapUsd: overrides?.costCapUsd ?? base.costCapUsd,
    maxRequests: overrides?.maxRequests ?? base.maxRequests,
    maxDurationMs: overrides?.maxDurationMs ?? base.maxDurationMs,
  };
}

/** The caller: the tenant the guard resolved and the user acting in it. */
export interface AssessmentRequestPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

export interface AssessmentRequestServiceDeps {
  readonly store: AssessmentRequestStore;
  readonly assets: AssetCatalog;
  readonly standingAuthorisations: StandingAuthorisationReader;
  readonly memberships: AssessmentRequestMemberships;
  readonly halts: TenantHaltState;
  readonly metrics: AssessmentRequestMetrics;
  readonly logger: Pick<Logger, 'info'>;
  readonly tracer?: Tracer;
  /** The asset-level policy (Cedar): may the caller act on this asset (SCOPE-005 requirement 6). */
  readonly policy: AssessmentPolicyEngine;
  /** Clock of the submit gate (SA expiry). Tests pass a fixed instant. */
  readonly now?: () => Date;
}

/** An answer: the body and the ETag that validates it (the version the row is at). */
export interface AssessmentRequestView {
  readonly body: AssessmentRequestResponse;
  readonly etag: string;
}

const AREQ_PUBLIC_ID_PREFIX = 'areq';

/** Maps a row to the wire shape. The public id is the only id the API exposes. */
function viewOf(row: AssessmentRequestRow): AssessmentRequestView {
  const body: AssessmentRequestResponse = {
    id: toPublicId(row.id, AREQ_PUBLIC_ID_PREFIX),
    status: row.status,
    mode: row.mode,
    objective: row.objective,
    assetIds: [...row.assetIds],
    saId: row.saId,
    inputManifestId: row.inputManifestId,
    scopeRules: row.scopeRules,
    maxIntrusiveness: row.maxIntrusiveness,
    budgets: row.budgets as AssessmentRequestResponse['budgets'],
    trigger: row.trigger,
    requestedBy: row.requestedBy,
    stateVersion: row.stateVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return { body, etag: versionEtag(row.stateVersion) };
}

/**
 * Assessment requests (SCOPE-005, §3.2 step 1): draft, edit, submit, withdraw. The service owns authorisation
 * (RBAC on writes, membership on reads), the existence rules (a foreign tenant's id is a uniform 404) and the
 * submit gate. The gate runs every check in `checkSubmission` and reports them all in one `422`. It never signs a
 * standing authorisation and never starts a run: a submitted request waits for PLAN/ORCH.
 */
export class AssessmentRequestService {
  private readonly tracer: Tracer;
  private readonly now: () => Date;

  constructor(private readonly deps: AssessmentRequestServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
    this.now = deps.now ?? (() => new Date());
  }

  /** Creates a `draft`. Every named asset must exist in the caller's tenant (else 404). */
  async create(
    principal: AssessmentRequestPrincipal,
    body: CreateAssessmentRequest,
  ): Promise<AssessmentRequestView> {
    const roles = await this.authorise(principal, 'assessment:create');
    await this.requireAssetAccess(principal, roles, body.assetIds);
    const createInput: AssessmentRequestCreate = {
      mode: body.mode,
      objective: body.objective,
      assetIds: body.assetIds,
      saId: body.saId ?? null,
      inputManifestId: body.inputManifestId ?? null,
      scopeRules: body.scopeRules ?? { rules: [] },
      maxIntrusiveness: body.maxIntrusiveness,
      budgets: withRunBudgets(RUN_BUDGET_DEFAULTS, body.budgets),
      trigger: body.trigger,
      requestedBy: principal.actorId,
    };
    const row = await this.deps.store.create(createInput);
    this.deps.logger.info(
      { tenantId: hashTenantId(principal.tenantId), requestId: row.id, mode: row.mode },
      'scope.request.created',
    );
    return viewOf(row);
  }

  /** The caller's tenant's requests, newest first. */
  async list(principal: AssessmentRequestPrincipal): Promise<AssessmentRequestView[]> {
    await this.authoriseMember(principal);
    return (await this.deps.store.list()).map((row) => viewOf(row));
  }

  async get(
    principal: AssessmentRequestPrincipal,
    requestPublicId: string,
  ): Promise<AssessmentRequestView> {
    await this.authoriseMember(principal);
    return viewOf(await this.findOrNotFound(requestPublicId));
  }

  /**
   * Edits a draft. Order: authorise, find (404), `If-Match` (428/412), then the patch. A non-draft is 409 from the
   * store; a patch naming an asset outside the tenant is 404.
   */
  async update(
    principal: AssessmentRequestPrincipal,
    requestPublicId: string,
    ifMatch: string | undefined,
    body: PatchAssessmentRequest,
  ): Promise<AssessmentRequestView> {
    const roles = await this.authorise(principal, 'assessment:create');
    const current = await this.findOrNotFound(requestPublicId);
    const { expectedVersion } = requireIfMatch(versionEtag(current.stateVersion), ifMatch);
    if (body.assetIds !== undefined) await this.requireAssetAccess(principal, roles, body.assetIds);
    const { budgets, ...fields } = body;
    const patch: AssessmentRequestUpdate =
      budgets === undefined
        ? fields
        : { ...fields, budgets: withRunBudgets(runBudgetsSchema.parse(current.budgets), budgets) };
    const row = await this.deps.store.updateDraft(
      current.id,
      expectedVersion ?? current.stateVersion,
      patch,
      principal.actorId,
    );
    return viewOf(row);
  }

  /**
   * Submits a draft after the full gate. Order: authorise, find (404), kill switch (409), gate (422 with every
   * failing check), then the transition. Idempotency-Key replays are answered by the route's interceptor.
   */
  async submit(
    principal: AssessmentRequestPrincipal,
    requestPublicId: string,
  ): Promise<AssessmentRequestView> {
    return this.inSpan(SUBMIT_SPAN, requestPublicId, async () => {
      const roles = await this.authorise(principal, 'assessment:create');
      const current = await this.findOrNotFound(requestPublicId);
      if (await this.deps.halts.isHalted(principal.tenantId)) {
        this.deps.metrics.submitted('halted');
        throw tenantHaltedError();
      }
      const assets = await this.deps.assets.findInTenant(principal.tenantId, current.assetIds);
      if (assets.length !== new Set(current.assetIds).size) {
        throw new NotFoundError('assessment request asset not found');
      }
      this.authoriseAssets(principal, roles, assets);
      const saId = current.saId;
      const sa =
        saId === null
          ? undefined
          : await this.deps.standingAuthorisations.findInTenant(principal.tenantId, saId);
      const failures = checkSubmission(
        {
          assetIds: current.assetIds,
          saId,
          maxIntrusiveness: current.maxIntrusiveness,
          scopeRules: current.scopeRules,
          budgets: current.budgets,
        },
        assets,
        sa,
        this.now(),
      );
      if (failures.length > 0) {
        this.recordFailures(failures);
        this.deps.logger.info(
          {
            tenantId: hashTenantId(principal.tenantId),
            requestId: current.id,
            codes: failures.map((f) => f.code),
          },
          'scope.request.submit_rejected',
        );
        throw new FieldValidationError('the assessment request cannot be submitted', {
          errors: failures.map((failure) => ({
            path: failure.path,
            message: failure.message,
            code: failure.code,
          })),
        });
      }
      const row = await this.deps.store.transition(
        current.id,
        current.stateVersion,
        'submitted',
        principal.actorId,
      );
      this.deps.metrics.submitted('submitted');
      this.deps.logger.info(
        {
          tenantId: hashTenantId(principal.tenantId),
          requestId: row.id,
          mode: row.mode,
          assetCount: row.assetIds.length,
        },
        'scope.request.submitted',
      );
      return viewOf(row);
    });
  }

  /** Withdraws a draft or a submitted request. `If-Match` is required, as on every state change. */
  async withdraw(
    principal: AssessmentRequestPrincipal,
    requestPublicId: string,
    ifMatch: string | undefined,
  ): Promise<AssessmentRequestView> {
    const roles = await this.authorise(principal, 'assessment:create');
    const current = await this.findOrNotFound(requestPublicId);
    const { expectedVersion } = requireIfMatch(versionEtag(current.stateVersion), ifMatch);
    await this.requireAssetAccess(principal, roles, current.assetIds);
    const row = await this.deps.store.transition(
      current.id,
      expectedVersion ?? current.stateVersion,
      'withdrawn',
      principal.actorId,
    );
    return viewOf(row);
  }

  /** Requires a permission in the tenant (fails closed for a non-UUID actor). */
  private async authorise(
    principal: AssessmentRequestPrincipal,
    permission: Permission,
  ): Promise<readonly string[]> {
    const roles = await this.rolesOf(principal);
    if (!hasPermission(roles, permission)) {
      throw new ForbiddenError('the caller may not manage assessment requests', {
        detail: `Missing permission ${permission} in this tenant.`,
      });
    }
    return roles;
  }

  /** Reads are open to every member of the tenant (a membership with at least one role). */
  private async authoriseMember(principal: AssessmentRequestPrincipal): Promise<void> {
    if ((await this.rolesOf(principal)).length === 0) {
      throw new ForbiddenError('the caller is not a member of this tenant', {
        detail: 'Assessment requests are visible to the members of this tenant.',
      });
    }
  }

  private async rolesOf(principal: AssessmentRequestPrincipal): Promise<readonly string[]> {
    return this.deps.memberships.rolesOf(principal.tenantId, principal.actorId);
  }

  /** The request named by a public id, or 404. A malformed id or a foreign tenant's row reads the same. */
  private async findOrNotFound(requestPublicId: string): Promise<AssessmentRequestRow> {
    let uuid: string;
    try {
      uuid = toUuid(requestPublicId, AREQ_PUBLIC_ID_PREFIX);
    } catch {
      throw new NotFoundError('assessment request not found');
    }
    const row = await this.deps.store.findById(uuid);
    if (row === undefined) throw new NotFoundError('assessment request not found');
    return row;
  }

  /**
   * Every named asset must exist in the tenant (a missing or foreign one is a uniform 404, no existence leak), and the
   * caller must be allowed to act on each one (Cedar, SCOPE-005 requirement 6).
   */
  private async requireAssetAccess(
    principal: AssessmentRequestPrincipal,
    roles: readonly string[],
    assetIds: readonly string[],
  ): Promise<void> {
    if (assetIds.length === 0) return;
    const found = await this.deps.assets.findInTenant(principal.tenantId, assetIds);
    if (found.length !== new Set(assetIds).size) {
      throw new NotFoundError('assessment request asset not found');
    }
    this.authoriseAssets(principal, roles, found);
  }

  /** Cedar: the caller may act on each of these assets. A refusal is a 403 that names no asset. */
  private authoriseAssets(
    principal: AssessmentRequestPrincipal,
    roles: readonly string[],
    assets: readonly AssetFact[],
  ): void {
    const who: AssessmentPolicyPrincipal = {
      userId: principal.actorId,
      tenantId: principal.tenantId,
      roles,
    };
    for (const asset of assets) {
      const decision = this.deps.policy.authorize(who, {
        id: asset.id,
        tenantId: principal.tenantId,
        ownerUserIds: [asset.ownerUserId],
      });
      if (decision !== 'allow') {
        throw new ForbiddenError('the caller may not act on these assets', {
          detail: 'The asset policy does not allow this action on one of the named assets.',
        });
      }
    }
  }

  private recordFailures(failures: readonly SubmitFailure[]): void {
    this.deps.metrics.submitted('validation_failed');
    for (const failure of failures) this.deps.metrics.validationFailed(failure.code);
  }

  private async inSpan<T>(name: string, requestPublicId: string, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(
      name,
      { attributes: { requestId: requestPublicId } },
      async (span: Span) => {
        try {
          return await fn();
        } catch (error) {
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
}
