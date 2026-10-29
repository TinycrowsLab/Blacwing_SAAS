import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import {
  standingAuthorisationDtoSchema,
  type CreateStandingAuthorisationInput,
  type Page,
  type PatchStandingAuthorisationInput,
  type Permission,
  type StandingAuthorisationDto,
  type RejectStandingAuthorisationInput,
} from '@blackwing/contracts';
import { hashTenantId } from '@blackwing/db/tenant-context';
import {
  assertSaDraft,
  hasPermission,
  type SaState,
  type SaTransitionResult,
  transitionSa,
} from '@blackwing/domain';
import { assertCanApprove, SodViolationError } from '@blackwing/domain/sod';
import { ForbiddenError, NotFoundError, PreconditionFailedError } from '@blackwing/errors';
import { StandingAuthorisationId } from '@blackwing/ids';

import { canonicalEnvelope } from './envelope.js';
import { AssetUnverifiedError, AuthzSodViolationError, NotDraftError } from './errors.js';
import { assertStepUp, type StepUpEvidence, type StepUpPolicy } from './step-up.js';
import { canonicalize, requireIfMatch, versionEtag } from '../concurrency/index.js';
import { invalidCursor, type CursorCodec } from '../pagination/index.js';

import type { ApprovalResult, AuthorisationMetrics, SubmitResult } from './metrics.js';
import type { SaPolicyAction, SaPolicyEngine, SaPolicyResource } from './policy.js';
import type {
  AssetVerifier,
  AuthorisationMemberships,
  EnvelopeSigner,
  StandingAuthorisationStore,
} from './ports.js';
import type {
  StandingAuthorisationAuditEvent,
  StandingAuthorisationFields,
  StandingAuthorisationRecord,
  StandingAuthorisationWrite,
} from '@blackwing/db';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/authorisations';
const uuidSchema = z.uuid();
const SPAN_CREATE = 'authz.create';
const SPAN_READ = 'authz.read';
const SPAN_LIST = 'authz.list';
const SPAN_UPDATE = 'authz.update';
const SPAN_SUBMIT = 'authz.submit';
const SPAN_APPROVE = 'authz.approve';
const SPAN_REJECT = 'authz.reject';

/** Page size when the client sends no `limit`, and the largest one (§9). */
const SA_LIST_LIMIT_DEFAULT = 50;
const SA_LIST_LIMIT_MAX = 200;
/** The cursor is over the id order only, so its signature is a constant. */
const LIST_SIGNATURE = 'standing-authorisations';
const LIST_DIRECTION = 'asc';

/** The caller: the tenant the guard resolved, the user acting in it, and its step-up evidence (AUTHZ-008). */
export interface AuthorisationPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
  /** The `acr` and `auth_time` of the caller's session, when the request carries them. */
  readonly auth?: StepUpEvidence;
}

/** A standing authorisation answer: the body and the ETag that validates it. */
export interface AuthorisationView {
  readonly body: StandingAuthorisationDto;
  readonly etag: string;
}

export interface AuthorisationServiceDeps {
  readonly store: StandingAuthorisationStore;
  readonly assets: AssetVerifier;
  readonly memberships: AuthorisationMemberships;
  readonly policy: SaPolicyEngine;
  readonly cursors: CursorCodec;
  readonly metrics: AuthorisationMetrics;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  /** Signs the approved envelope (AUTHZ-004). Required: an approval cannot be released unsigned. */
  readonly signer: EnvelopeSigner;
  /** The step-up requirement of an approval (`AUTHZ_STEPUP_MAX_AGE_S`, `AUTHZ_STEPUP_ACR`). */
  readonly stepUp: StepUpPolicy;
  /** Epoch milliseconds; defaults to `Date.now`. Drives the step-up freshness and the decision instant. */
  readonly now?: () => number;
  readonly tracer?: Tracer;
}

/** The mutable draft fields, as the database stores them. */
type DraftPatch = Partial<StandingAuthorisationFields>;

/** Stored row to the caller-set fields (the draft content). */
function fieldsOf(record: StandingAuthorisationRecord): StandingAuthorisationFields {
  return {
    assetIds: record.assetIds,
    scopeRules: record.scopeRules,
    maxIntrusiveness: record.maxIntrusiveness,
    preApprovedTestClasses: record.preApprovedTestClasses,
    defaultBudgets: record.defaultBudgets,
    testWindows: record.testWindows,
    validFrom: record.validFrom,
    expiresAt: record.expiresAt,
  };
}

/** The fields a PATCH sets, with the instants parsed. Only the keys the client sent are present. */
function patchOf(patch: PatchStandingAuthorisationInput): DraftPatch {
  return {
    ...(patch.assetIds === undefined ? {} : { assetIds: patch.assetIds }),
    ...(patch.scopeRules === undefined ? {} : { scopeRules: patch.scopeRules }),
    ...(patch.maxIntrusiveness === undefined ? {} : { maxIntrusiveness: patch.maxIntrusiveness }),
    ...(patch.preApprovedTestClasses === undefined
      ? {}
      : { preApprovedTestClasses: patch.preApprovedTestClasses }),
    ...(patch.defaultBudgets === undefined ? {} : { defaultBudgets: patch.defaultBudgets }),
    ...(patch.testWindows === undefined ? {} : { testWindows: patch.testWindows }),
    ...(patch.validFrom === undefined ? {} : { validFrom: new Date(patch.validFrom) }),
    ...(patch.expiresAt === undefined ? {} : { expiresAt: new Date(patch.expiresAt) }),
  };
}

/** The draft fields of a create body, with the instants parsed. */
function createOf(body: CreateStandingAuthorisationInput): StandingAuthorisationFields {
  return {
    ...patchOf(body),
    assetIds: body.assetIds,
    scopeRules: body.scopeRules,
    maxIntrusiveness: body.maxIntrusiveness,
    preApprovedTestClasses: body.preApprovedTestClasses,
    defaultBudgets: body.defaultBudgets,
    testWindows: body.testWindows,
    validFrom: new Date(body.validFrom),
    expiresAt: new Date(body.expiresAt),
  };
}

/** Which patch keys actually change the stored value. Compared in canonical JSON, so equal values are no change. */
function changedKeys(current: StandingAuthorisationFields, patch: DraftPatch): string[] {
  return Object.keys(patch)
    .filter((key) => {
      const field = key as keyof StandingAuthorisationFields;
      return canonicalize(current[field]) !== canonicalize(patch[field]);
    })
    .sort();
}

/**
 * The wire form of a stored row. The stored JSON is parsed by the DTO schema, so a row that does not match
 * the contract fails closed (500) instead of leaking a malformed body.
 */
function bodyOf(record: StandingAuthorisationRecord): StandingAuthorisationDto {
  return standingAuthorisationDtoSchema.parse({
    id: record.publicId,
    assetIds: record.assetIds,
    scopeRules: record.scopeRules,
    maxIntrusiveness: record.maxIntrusiveness,
    preApprovedTestClasses: record.preApprovedTestClasses,
    defaultBudgets: record.defaultBudgets,
    testWindows: record.testWindows,
    validFrom: record.validFrom.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    requesterId: record.requesterId,
    approverId: record.approverId,
    signature: record.signature,
    signingKeyId: record.signingKeyId,
    status: record.status,
    revocationReason: record.revocationReason,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function viewOf(record: StandingAuthorisationRecord): AuthorisationView {
  return { body: bodyOf(record), etag: versionEtag(record.version) };
}

function stateOf(record: StandingAuthorisationRecord): SaState {
  return {
    status: record.status,
    version: record.version,
    requesterId: record.requesterId,
    approverId: record.approverId,
    expiresAt: record.expiresAt,
    revocationReason: record.revocationReason,
  };
}

/** The public id of a path parameter as the stored uuid. Anything else is simply not found. */
function uuidOf(publicId: string): string {
  try {
    return StandingAuthorisationId.toUuid(publicId);
  } catch {
    throw new NotFoundError('standing authorisation not found');
  }
}

/** The resource a decision is checked against: the SA, with its requester (Cedar's separation-of-duties rule). */
function decisionResourceOf(record: StandingAuthorisationRecord): SaPolicyResource {
  return {
    kind: 'StandingAuthorisation',
    id: record.id,
    tenantId: record.tenantId,
    requesterId: record.requesterId,
  };
}

/** Standing authorisations (AUTHZ-002, AUTHZ-008): draft, read, list, patch, submit, approve and reject under RBAC, Cedar, ETags and audit. */
export class AuthorisationService {
  private readonly tracer: Tracer;
  private readonly now: () => number;

  constructor(private readonly deps: AuthorisationServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
    this.now = deps.now ?? Date.now;
  }

  /** `POST`: a new draft owned by the caller. Its status is `draft` and its version 1. */
  async create(
    principal: AuthorisationPrincipal,
    body: CreateStandingAuthorisationInput,
  ): Promise<AuthorisationView> {
    return this.inSpan(SPAN_CREATE, async () => {
      const roles = await this.requirePermission(principal, 'sa:create');
      this.requirePolicy(principal, roles, 'create', {
        kind: 'Tenant',
        tenantId: principal.tenantId,
      });
      const fields = createOf(body);
      assertSaDraft({
        assetIds: fields.assetIds,
        maxIntrusiveness: fields.maxIntrusiveness,
        validFrom: fields.validFrom,
        expiresAt: fields.expiresAt,
      });
      const publicId = StandingAuthorisationId.generate();
      const row = await this.deps.store.insertDraft(
        principal.tenantId,
        {
          ...fields,
          id: StandingAuthorisationId.toUuid(publicId),
          publicId,
          requesterId: principal.actorId,
        },
        {
          action: 'authz.sa.created',
          actorId: principal.actorId,
          saId: publicId,
          changedFields: Object.keys(body).sort(),
        },
      );
      this.deps.logger.info(
        { tenantId: hashTenantId(principal.tenantId), saId: publicId, action: 'authz.sa.created' },
        'authz.sa.created',
      );
      return viewOf(row);
    });
  }

  /** `GET /:id`: one standing authorisation of the caller's tenant. */
  async get(principal: AuthorisationPrincipal, publicId: string): Promise<AuthorisationView> {
    return this.inSpan(SPAN_READ, async () => {
      const record = await this.loadAuthorised(principal, publicId, 'sa:read', 'read');
      return viewOf(record);
    });
  }

  /** `GET`: one cursor page in id order. `nextCursor` is null on the last page. */
  async list(
    principal: AuthorisationPrincipal,
    query: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  ): Promise<Page<StandingAuthorisationDto>> {
    return this.inSpan(SPAN_LIST, async () => {
      const roles = await this.requirePermission(principal, 'sa:read');
      this.requirePolicy(principal, roles, 'read', {
        kind: 'Tenant',
        tenantId: principal.tenantId,
      });
      const limit = Math.min(query.limit ?? SA_LIST_LIMIT_DEFAULT, SA_LIST_LIMIT_MAX);
      const afterId = query.cursor === undefined ? undefined : this.afterIdOf(query.cursor);
      const rows = await this.deps.store.list(principal.tenantId, {
        ...(afterId === undefined ? {} : { afterId }),
        limit,
      });
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((item) => bodyOf(item)),
        nextCursor:
          hasMore && last !== undefined
            ? this.deps.cursors.encode({
                k: [last.id],
                d: LIST_DIRECTION,
                s: LIST_SIGNATURE,
              })
            : null,
        hasMore,
      };
    });
  }

  /**
   * `PATCH /:id`: changes a draft. Order: RBAC and Cedar, then the row (404), then `If-Match` (428 when
   * absent, 412 when stale), then the lifecycle (409 when not a draft), then the AUTHZ-001 invariants on the
   * merged draft (422), then the conditional write (412 if a concurrent writer won). An unchanged patch
   * writes nothing and answers the current state.
   */
  async update(
    principal: AuthorisationPrincipal,
    publicId: string,
    ifMatch: string | undefined,
    patch: PatchStandingAuthorisationInput,
  ): Promise<AuthorisationView> {
    return this.inSpan(SPAN_UPDATE, async () => {
      const record = await this.loadAuthorised(principal, publicId, 'sa:create', 'update');
      const precondition = this.preconditionOf(record, ifMatch);
      if (record.status !== 'draft') throw new NotDraftError();
      const draft = patchOf(patch);
      const changed = changedKeys(fieldsOf(record), draft);
      if (changed.length === 0) return viewOf(record);
      const merged = { ...fieldsOf(record), ...draft };
      assertSaDraft({
        assetIds: merged.assetIds,
        maxIntrusiveness: merged.maxIntrusiveness,
        validFrom: merged.validFrom,
        expiresAt: merged.expiresAt,
      });
      const updated = await this.deps.store.writeIf(
        principal.tenantId,
        record.id,
        precondition.expectedVersion,
        { fields: draft },
        {
          action: 'authz.sa.updated',
          actorId: principal.actorId,
          saId: record.publicId,
          changedFields: changed,
        },
      );
      if (updated === undefined) throw this.concurrentWrite();
      return viewOf(updated);
    });
  }

  /**
   * `POST /:id/submit`: draft to `pending_approval`. The AUTHZ-001 lifecycle decides the transition, the
   * invariants are re-checked on the stored draft, and every asset must be verified for the tenant
   * (`AUTHZ_ASSET_UNVERIFIED`, fail closed). The metric counts each call once, as submitted or refused.
   */
  async submit(
    principal: AuthorisationPrincipal,
    publicId: string,
    ifMatch: string | undefined,
  ): Promise<AuthorisationView> {
    return this.inSpan(SPAN_SUBMIT, async (span) => {
      let result: SubmitResult = 'refused';
      try {
        const record = await this.loadAuthorised(principal, publicId, 'sa:create', 'submit');
        span.setAttribute('sa_id', record.publicId);
        const precondition = this.preconditionOf(record, ifMatch);
        const transition: SaTransitionResult = transitionSa(stateOf(record), 'submit', {
          actor: { kind: 'user', id: principal.actorId },
          now: new Date(),
        });
        assertSaDraft({
          assetIds: record.assetIds,
          maxIntrusiveness: record.maxIntrusiveness,
          validFrom: record.validFrom,
          expiresAt: record.expiresAt,
        });
        const unverified = await this.deps.assets.unverified(principal.tenantId, record.assetIds);
        if (unverified.length > 0) throw new AssetUnverifiedError();
        const updated = await this.deps.store.writeIf(
          principal.tenantId,
          record.id,
          precondition.expectedVersion,
          { fields: {}, status: transition.next.status },
          {
            action: 'authz.sa.submitted',
            actorId: principal.actorId,
            saId: record.publicId,
            changedFields: ['status'],
            from: transition.auditIntent.from,
            to: transition.auditIntent.to,
          },
        );
        if (updated === undefined) throw this.concurrentWrite();
        result = 'submitted';
        this.deps.logger.info(
          {
            tenantId: hashTenantId(principal.tenantId),
            saId: record.publicId,
            action: 'authz.sa.submitted',
          },
          'authz.sa.submitted',
        );
        return viewOf(updated);
      } finally {
        this.deps.metrics.submitted(result);
      }
    });
  }

  /**
   * `POST /:id/approve` (AUTHZ-008): a pending standing authorisation becomes `active`. Order: RBAC and Cedar, the row
   * (404), `If-Match` (428/412), separation of duties (403 `AUTHZ_SOD_VIOLATION`), step-up (401
   * `AUTHZ_STEPUP_REQUIRED`), the lifecycle (409 when not pending). Then the envelope is signed (503 when the signer is
   * down, nothing persisted), the caller's approver role is re-checked at commit, and one transaction writes the state,
   * the signature, the envelope hash, the gate decision and their audit events. Any failure leaves the SA pending.
   */
  async approve(
    principal: AuthorisationPrincipal,
    publicId: string,
    ifMatch: string | undefined,
  ): Promise<AuthorisationView> {
    return this.inSpan(SPAN_APPROVE, async (span) => {
      let result: ApprovalResult = 'refused';
      try {
        const { record, roles } = await this.loadDecidable(principal, publicId, 'approve');
        span.setAttribute('sa_id', record.publicId);
        const precondition = this.preconditionOf(record, ifMatch);
        this.assertCanDecide(principal, roles, record, 'sa.approve');
        assertStepUp(principal.auth ?? {}, this.deps.stepUp, this.now());
        const decidedAt = new Date(this.now());
        const transition = transitionSa(stateOf(record), 'approve', {
          actor: { kind: 'user', id: principal.actorId },
          now: decidedAt,
        });
        const signed = await this.deps.signer.signEnvelope({
          tenantId: principal.tenantId,
          saId: record.publicId,
          canonicalBytes: canonicalEnvelope(record, {
            approverId: principal.actorId,
            version: transition.next.version,
          }),
        });
        // Re-checked at commit: an approver who lost the role while the signature was made is refused, and nothing is written.
        const committedRoles = await this.requirePermission(principal, 'sa:approve');
        this.requirePolicy(principal, committedRoles, 'approve', decisionResourceOf(record));
        this.assertCanDecide(principal, committedRoles, record, 'sa.approve');
        const updated = await this.decisionWrite(
          principal,
          record,
          precondition.expectedVersion,
          {
            fields: {},
            status: transition.next.status,
            approval: {
              approverId: principal.actorId,
              signature: signed.signature,
              signingKeyId: signed.signingKeyId,
              envelopeHash: signed.envelopeHash,
            },
            decision: {
              decision: 'approved',
              actorId: principal.actorId,
              reason: null,
              decidedAt,
            },
          },
          {
            action: 'authz.sa.approved',
            changedFields: ['approverId', 'envelopeHash', 'signature', 'signingKeyId', 'status'],
            from: transition.auditIntent.from,
            to: transition.auditIntent.to,
          },
        );
        result = 'approved';
        this.deps.logger.info(
          {
            tenantId: hashTenantId(principal.tenantId),
            saId: record.publicId,
            approverId: principal.actorId,
            action: 'authz.sa.approved',
          },
          'authz.sa.approved',
        );
        return viewOf(updated);
      } finally {
        this.deps.metrics.approval(result);
      }
    });
  }

  /**
   * `POST /:id/reject` (AUTHZ-008): a pending standing authorisation returns to `draft` with the reason recorded as
   * a rejected gate decision. Order and refusals match {@link approve}, without the step-up and the signature.
   */
  async reject(
    principal: AuthorisationPrincipal,
    publicId: string,
    ifMatch: string | undefined,
    input: RejectStandingAuthorisationInput,
  ): Promise<AuthorisationView> {
    return this.inSpan(SPAN_REJECT, async (span) => {
      let result: ApprovalResult = 'refused';
      try {
        const { record, roles } = await this.loadDecidable(principal, publicId, 'reject');
        span.setAttribute('sa_id', record.publicId);
        const precondition = this.preconditionOf(record, ifMatch);
        this.assertCanDecide(principal, roles, record, 'sa.reject');
        const decidedAt = new Date(this.now());
        const transition = transitionSa(stateOf(record), 'reject', {
          actor: { kind: 'user', id: principal.actorId },
          now: decidedAt,
        });
        const committedRoles = await this.requirePermission(principal, 'sa:approve');
        this.requirePolicy(principal, committedRoles, 'reject', decisionResourceOf(record));
        this.assertCanDecide(principal, committedRoles, record, 'sa.reject');
        const updated = await this.decisionWrite(
          principal,
          record,
          precondition.expectedVersion,
          {
            fields: {},
            status: transition.next.status,
            decision: {
              decision: 'rejected',
              actorId: principal.actorId,
              reason: input.reason,
              decidedAt,
            },
          },
          {
            action: 'authz.sa.rejected',
            changedFields: ['status'],
            from: transition.auditIntent.from,
            to: transition.auditIntent.to,
          },
        );
        result = 'rejected';
        this.deps.logger.info(
          {
            tenantId: hashTenantId(principal.tenantId),
            saId: record.publicId,
            approverId: principal.actorId,
            action: 'authz.sa.rejected',
          },
          'authz.sa.rejected',
        );
        return viewOf(updated);
      } finally {
        this.deps.metrics.approval(result);
      }
    });
  }

  /**
   * Authorises a read or a change of one standing authorisation, and loads it. RBAC first (a missing
   * permission is 403 whatever the id), then the row (a missing or cross-tenant row is 404, RLS), then the
   * Cedar resource rules on the loaded row.
   */
  private async loadAuthorised(
    principal: AuthorisationPrincipal,
    publicId: string,
    permission: Permission,
    action: SaPolicyAction,
  ): Promise<StandingAuthorisationRecord> {
    return (await this.loadWithRoles(principal, publicId, permission, action)).record;
  }

  /** {@link loadAuthorised} for an approve or reject: the `sa:approve` permission, and the caller's roles for SoD. */
  private async loadDecidable(
    principal: AuthorisationPrincipal,
    publicId: string,
    action: 'approve' | 'reject',
  ): Promise<{ readonly record: StandingAuthorisationRecord; readonly roles: readonly string[] }> {
    return this.loadWithRoles(principal, publicId, 'sa:approve', action);
  }

  private async loadWithRoles(
    principal: AuthorisationPrincipal,
    publicId: string,
    permission: Permission,
    action: SaPolicyAction,
  ): Promise<{ readonly record: StandingAuthorisationRecord; readonly roles: readonly string[] }> {
    const roles = await this.requirePermission(principal, permission);
    const id = uuidOf(publicId);
    const record = await this.deps.store.read(principal.tenantId, id);
    if (record === undefined) throw new NotFoundError('standing authorisation not found');
    this.requirePolicy(principal, roles, action, decisionResourceOf(record));
    return { record, roles };
  }

  /**
   * Separation of duties (§8.4): the approver must be a person other than the requester and hold the approver role.
   * A refusal is `AUTHZ_SOD_VIOLATION` (403); the `@blackwing/domain` check also logs the reason.
   */
  private assertCanDecide(
    principal: AuthorisationPrincipal,
    roles: readonly string[],
    record: StandingAuthorisationRecord,
    context: 'sa.approve' | 'sa.reject',
  ): void {
    try {
      assertCanApprove(principal.actorId, roles, record.requesterId, context, {
        logger: this.deps.logger,
      });
    } catch (error) {
      if (error instanceof SodViolationError) throw new AuthzSodViolationError();
      throw error;
    }
  }

  /**
   * The conditional write of a decision, with its gate decision and audit events in one transaction. A second
   * separation-of-duties refusal from the database (the trigger or the gate row) is the same 403.
   */
  private async decisionWrite(
    principal: AuthorisationPrincipal,
    record: StandingAuthorisationRecord,
    expectedVersion: number,
    write: StandingAuthorisationWrite,
    audit: Omit<StandingAuthorisationAuditEvent, 'tenantId' | 'actorId' | 'saId'>,
  ): Promise<StandingAuthorisationRecord> {
    let updated: StandingAuthorisationRecord | undefined;
    try {
      updated = await this.deps.store.writeIf(
        principal.tenantId,
        record.id,
        expectedVersion,
        write,
        { ...audit, actorId: principal.actorId, saId: record.publicId },
      );
    } catch (error) {
      if (error instanceof SodViolationError) throw new AuthzSodViolationError();
      throw error;
    }
    if (updated === undefined) throw this.concurrentWrite();
    return updated;
  }

  /** The concurrency check of a change: `If-Match` must name the stored version (428 absent, 412 stale). */
  private preconditionOf(
    record: StandingAuthorisationRecord,
    ifMatch: string | undefined,
  ): { readonly expectedVersion: number } {
    const checked = requireIfMatch(versionEtag(record.version), ifMatch);
    return { expectedVersion: checked.expectedVersion ?? record.version };
  }

  private concurrentWrite(): PreconditionFailedError {
    return new PreconditionFailedError(
      'The standing authorisation was modified concurrently; re-fetch it and retry.',
      { detail: 'Re-fetch the standing authorisation and retry with its current ETag.' },
    );
  }

  /**
   * RBAC: the caller's roles in the tenant must hold the permission. Returns those roles for the Cedar
   * check. A non-UUID user id has no membership, so it holds no roles and is refused.
   */
  private async requirePermission(
    principal: AuthorisationPrincipal,
    permission: Permission,
  ): Promise<readonly string[]> {
    const roles = await this.rolesOf(principal);
    if (!hasPermission(roles, permission)) {
      throw new ForbiddenError('the caller may not use standing authorisations', {
        detail: `Missing permission ${permission} in this tenant.`,
      });
    }
    return roles;
  }

  /** Cedar: the resource rules for one action, given the caller's roles. Any refusal is a 403. */
  private requirePolicy(
    principal: AuthorisationPrincipal,
    roles: readonly string[],
    action: SaPolicyAction,
    resource: SaPolicyResource,
  ): void {
    const allowed = this.deps.policy.allows(
      { userId: principal.actorId, tenantId: principal.tenantId, roles },
      action,
      resource,
    );
    if (!allowed) {
      throw new ForbiddenError(
        'the caller may not perform this action on the standing authorisation',
        {
          detail: `The resource policy refused ${action} in this tenant.`,
        },
      );
    }
  }

  private async rolesOf(principal: AuthorisationPrincipal): Promise<readonly string[]> {
    const userId = uuidSchema.safeParse(principal.actorId);
    return userId.success ? this.deps.memberships.rolesOf(principal.tenantId, userId.data) : [];
  }

  /** Decodes a list cursor into the id it names. Any tampering or mismatch is `invalid_cursor`. */
  private afterIdOf(token: string): string {
    let payload: ReturnType<CursorCodec['decode']>;
    try {
      payload = this.deps.cursors.decode(token, { d: LIST_DIRECTION, s: LIST_SIGNATURE });
    } catch {
      throw invalidCursor();
    }
    const [id] = payload.k;
    if (payload.k.length !== 1 || typeof id !== 'string') throw invalidCursor();
    return id;
  }

  private async inSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span: Span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
