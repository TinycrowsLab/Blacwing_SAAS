import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import {
  type OncallLevel,
  type OncallMember,
  type OncallRoster,
  type OncallRosterCreate,
  oncallRosterCreateSchema,
  oncallRosterPatchSchema,
  oncallRosterSchema,
  type OncallSchedule,
  type OncallScheduleInput,
  uuidV7Schema,
} from '@blackwing/contracts';
import { hasPermission } from '@blackwing/domain';
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
} from '@blackwing/errors';
import { newId } from '@blackwing/ids';
import { type Clock, systemClock } from '@blackwing/time';

import { OncallError } from './errors.js';
import { boundaryToInstant } from './zoned-time.js';

import type { OncallMetrics } from './metrics.js';
import type {
  OncallAuditSink,
  OncallConflictReason,
  OncallExceptionReader,
  OncallPrincipal,
  OncallStore,
} from './ports.js';
import type { AuditEventInput } from '@blackwing/audit';
import type { Logger } from '@blackwing/logger';
import type { z } from 'zod';

export const ONCALL_RESOLVE_SPAN = 'oncall.resolve';
const TRACER_NAME = '@blackwing/api/oncall';

export interface OncallServiceDeps {
  readonly store: OncallStore;
  readonly exceptions: OncallExceptionReader;
  readonly audit: OncallAuditSink;
  readonly logger: Logger;
  readonly metrics: OncallMetrics;
  readonly clock?: Clock;
  readonly idGenerator?: () => string;
  readonly tracer?: Tracer;
}

/** Who may not approve this exception (§8.4). A missing requester is a caller defect: it fails closed. */
export interface OncallExclusions {
  readonly requesterId: string;
  readonly planApproverId: string | null;
}

/** One person to page, as the paging transport (GATE2-007) needs them. User references only. */
export interface Responder {
  readonly userId: string;
  readonly level: OncallLevel;
  readonly orderIndex: number;
  /** Notification channel ids; never empty here (a member with none is not pageable). */
  readonly channelRefs: readonly string[];
}

/** The responders of one escalation level, after SoD exclusion. */
export interface EscalationStep {
  readonly stepIndex: number;
  readonly level: OncallLevel;
  readonly responders: readonly Responder[];
}

export interface ResolveRespondersInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly exclude: OncallExclusions;
  /** The instant to resolve at; defaults to now. */
  readonly at?: Date;
}

export interface ResolvedResponders {
  readonly rosterId: string;
  readonly at: string;
  /** Escalation steps in order (level, then `orderIndex`); levels with nobody to page are absent. */
  readonly steps: readonly EscalationStep[];
  /** Every responder, flattened in escalation order. */
  readonly responders: readonly Responder[];
  /** On-call members dropped because they are the requester or the plan approver. */
  readonly excludedForSod: number;
}

export interface GetEscalationStepInput {
  readonly tenantId: string;
  readonly exceptionId: string;
  readonly stepIndex: number;
  readonly at?: Date;
}

export interface EscalationStepResult extends EscalationStep {
  readonly rosterId: string;
  readonly totalSteps: number;
  /** True when no further level remains: the next escalation is the operator pause (GATE2-004). */
  readonly isLast: boolean;
}

const sameUser = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const byPosition = (a: OncallMember, b: OncallMember): number =>
  a.level - b.level || a.orderIndex - b.orderIndex || a.id.localeCompare(b.id);

function actorOf(principal: OncallPrincipal): AuditEventInput['actor'] {
  const tokenId = principal.tokenId === undefined ? {} : { tokenId: principal.tokenId };
  return principal.type === 'user'
    ? { type: 'user', id: principal.id, ...tokenId }
    : { type: 'service', id: principal.id, ...tokenId };
}

const CONFLICT_DETAIL: Readonly<Record<OncallConflictReason, string>> = {
  active_roster_exists:
    'the tenant already has an active on-call roster; deactivate it first or create this one inactive',
  name_taken: 'a roster with this name already exists',
};

/**
 * Who is paged for a Gate 2 exception, and in what order (GATE2-003, F13/F31). Pure policy over the
 * ports: SoD exclusion is applied before ordering, and an empty eligible set is an error that the
 * caller turns into an operator pause and, finally, a deny. It never returns "nobody, carry on".
 */
export class OncallService {
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly tracer: Tracer;

  constructor(private readonly deps: OncallServiceDeps) {
    this.clock = deps.clock ?? systemClock;
    this.nextId = deps.idGenerator ?? newId;
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  /**
   * The ordered pages for a run's Gate 2 exception: members on call at `at`, minus the requester and
   * the plan approver, grouped by escalation level and ordered by `orderIndex`.
   *
   * @throws OncallError `GATE2_NO_ONCALL_CONFIGURED` when there is no roster, nobody on call or nobody
   *   with a notification channel; `GATE2_NO_ELIGIBLE_APPROVER` when everyone on call is SoD-ineligible.
   */
  async resolveResponders(input: ResolveRespondersInput): Promise<ResolvedResponders> {
    return this.tracer.startActiveSpan(ONCALL_RESOLVE_SPAN, async (span) => {
      try {
        span.setAttributes({ 'bw.tenant_id': input.tenantId, 'bw.run_id': input.runId });
        return await this.resolve(input);
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /**
   * The responders of escalation step `stepIndex` for a Gate 2 exception. Steps are the non-empty
   * levels in order, so a level skipped for SoD never shows up as an empty step.
   *
   * @throws OncallError `GATE2_NO_ELIGIBLE_APPROVER` when `stepIndex` is past the last step (the ladder
   *   is exhausted: GATE2-004 escalates to the operator pause).
   */
  async getEscalationStep(input: GetEscalationStepInput): Promise<EscalationStepResult> {
    if (!Number.isSafeInteger(input.stepIndex) || input.stepIndex < 0) {
      throw new ValidationError('stepIndex must be a non-negative integer');
    }
    const exception = await this.deps.exceptions.get(input.tenantId, input.exceptionId);
    // Another tenant's exception and a missing one are the same answer (no existence oracle, §8.6).
    if (exception === null) throw new NotFoundError('gate 2 exception not found');
    const resolved = await this.resolveResponders({
      tenantId: input.tenantId,
      runId: exception.runId,
      exclude: { requesterId: exception.requesterId, planApproverId: exception.planApproverId },
      ...(input.at === undefined ? {} : { at: input.at }),
    });
    const step = resolved.steps[input.stepIndex];
    if (step === undefined) {
      throw new OncallError(
        'GATE2_NO_ELIGIBLE_APPROVER',
        `escalation step ${String(input.stepIndex)} is past the last of ${String(resolved.steps.length)} steps`,
      );
    }
    return {
      ...step,
      rosterId: resolved.rosterId,
      totalSteps: resolved.steps.length,
      isLast: input.stepIndex === resolved.steps.length - 1,
    };
  }

  /**
   * Preflight (run configuration): is anyone on call and reachable right now, ignoring SoD (the
   * requester is not known yet)? Same error as the resolver, so a run is refused before it starts.
   */
  async assertConfigured(tenantId: string, at?: Date): Promise<void> {
    const roster = await this.deps.store.getActive(tenantId);
    const instant = at ?? this.clock.now();
    const reachable =
      roster === null
        ? []
        : this.onCallAt(roster, instant).filter((member) => member.channelRefs.length > 0);
    if (reachable.length === 0) {
      this.deps.metrics.emptyRoster.inc();
      throw new OncallError(
        'GATE2_NO_ONCALL_CONFIGURED',
        'no one is on call with a notification channel; configure an active on-call roster',
      );
    }
  }

  async listRosters(principal: OncallPrincipal): Promise<readonly OncallRoster[]> {
    const tenantId = this.authorise(principal, 'settings:read');
    return this.deps.store.list(tenantId);
  }

  async getRoster(principal: OncallPrincipal, rosterId: string): Promise<OncallRoster> {
    const tenantId = this.authorise(principal, 'settings:read');
    return this.requireRoster(tenantId, rosterId);
  }

  /** Creates a roster. Only Org Admin (`settings:write`); audited as `oncall.roster.updated`. */
  async createRoster(
    principal: OncallPrincipal,
    body: unknown,
    traceId: string | null,
  ): Promise<OncallRoster> {
    const tenantId = this.authorise(principal, 'settings:write');
    const request = this.parse(oncallRosterCreateSchema, body);
    const now = this.clock.now().toISOString();
    const candidate = this.build({
      id: this.nextId(),
      tenantId,
      request,
      stateVersion: 0,
      createdAt: now,
      updatedAt: now,
      existingMembers: [],
    });
    const result = await this.deps.store.insert(
      candidate,
      rosterAudit(principal, candidate, 'created', traceId),
    );
    if (result.kind === 'conflict') throw this.conflict(result.reason);
    return result.roster;
  }

  /**
   * Changes a roster. `expectedVersion` is the `stateVersion` from the caller's `If-Match` ETag; a
   * stale one is refused (the route turns it into 412). A list in the patch replaces the stored list.
   */
  async updateRoster(
    principal: OncallPrincipal,
    rosterId: string,
    body: unknown,
    expectedVersion: number,
    traceId: string | null,
  ): Promise<OncallRoster> {
    const tenantId = this.authorise(principal, 'settings:write');
    const patch = this.parse(oncallRosterPatchSchema, body);
    const current = await this.requireRoster(tenantId, rosterId);
    const now = this.clock.now().toISOString();
    const timezone = patch.timezone ?? current.timezone;
    const request: OncallRosterCreate = {
      name: patch.name ?? current.name,
      timezone,
      active: patch.active ?? current.active,
      members:
        patch.members ??
        current.members.map((m) => ({
          userId: m.userId,
          level: m.level,
          orderIndex: m.orderIndex,
          channelRefs: m.channelRefs,
        })),
      // Stored windows are UTC instants; they are re-read, not re-zoned, when only the zone changes.
      schedules:
        patch.schedules ??
        current.schedules.map((s) => ({
          userId: s.userId,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
        })),
    };
    const candidate = this.build({
      id: current.id,
      tenantId,
      request,
      stateVersion: current.stateVersion,
      createdAt: current.createdAt,
      updatedAt: now,
      existingMembers: current.members,
    });
    const result = await this.deps.store.update(
      candidate,
      expectedVersion,
      rosterAudit(
        principal,
        { ...candidate, stateVersion: expectedVersion + 1 },
        'updated',
        traceId,
      ),
    );
    if (result.kind === 'stale') throw this.stale();
    if (result.kind === 'conflict') throw this.conflict(result.reason);
    return result.roster;
  }

  private async resolve(input: ResolveRespondersInput): Promise<ResolvedResponders> {
    const { tenantId, runId, exclude } = input;
    if (!isNonEmpty(exclude.requesterId)) {
      // SoD cannot be applied without knowing who asked: refuse rather than page the requester.
      throw new ValidationError('the requester must be named to resolve approvers');
    }
    const instant = input.at ?? this.clock.now();
    const roster = await this.deps.store.getActive(tenantId);
    const onCall = roster === null ? [] : this.onCallAt(roster, instant);
    if (roster === null || onCall.length === 0) {
      this.deps.metrics.emptyRoster.inc();
      this.deps.metrics.resolve.inc({ outcome: 'no_oncall_configured' });
      this.deps.logger.warn(
        { tenantId, runId, respondersCount: 0, excludedForSod: 0 },
        'oncall.resolve',
      );
      throw new OncallError(
        'GATE2_NO_ONCALL_CONFIGURED',
        roster === null
          ? 'the tenant has no active on-call roster'
          : 'no one is on call at this time',
      );
    }

    // SoD first (§8.4), then ordering: an excluded user never occupies a position in the ladder.
    const barred = [exclude.requesterId, exclude.planApproverId].filter(isNonEmpty);
    const eligible = onCall.filter((m) => !barred.some((id) => sameUser(id, m.userId)));
    const excludedForSod = onCall.length - eligible.length;

    const levels = [...new Set(onCall.map((m) => m.level))].sort((a, b) => a - b);
    const steps: EscalationStep[] = [];
    let skippedForSod = 0;
    for (const level of levels) {
      const here = eligible.filter((m) => m.level === level).sort(byPosition);
      if (here.length === 0) {
        skippedForSod += 1;
        await this.recordSodSkip(tenantId, runId, roster.id, level, onCall);
        continue;
      }
      const pageable: Responder[] = [];
      for (const member of here) {
        if (member.channelRefs.length === 0) {
          // Logged by user reference only; a person without a channel cannot be paged (edge case).
          this.deps.logger.warn(
            { tenantId, runId, userId: member.userId, level },
            'oncall.no_channel',
          );
          continue;
        }
        pageable.push({
          userId: member.userId,
          level,
          orderIndex: member.orderIndex,
          channelRefs: [...member.channelRefs],
        });
      }
      if (pageable.length > 0) steps.push({ stepIndex: steps.length, level, responders: pageable });
    }

    const responders = steps.flatMap((step) => step.responders);
    this.deps.logger.info(
      { tenantId, runId, respondersCount: responders.length, excludedForSod },
      'oncall.resolve',
    );
    if (steps.length === 0) {
      // Everyone on call is barred by SoD, or has nobody reachable. Both fail toward deny (F13).
      const allBarred = eligible.length === 0;
      this.deps.metrics.resolve.inc({
        outcome: allBarred ? 'no_eligible_approver' : 'no_oncall_configured',
      });
      if (!allBarred) this.deps.metrics.emptyRoster.inc();
      throw allBarred
        ? new OncallError(
            'GATE2_NO_ELIGIBLE_APPROVER',
            `every on-call member is the requester or the plan approver (${String(skippedForSod)} levels skipped)`,
          )
        : new OncallError(
            'GATE2_NO_ONCALL_CONFIGURED',
            'no eligible on-call member has a notification channel',
          );
    }
    this.deps.metrics.resolve.inc({ outcome: 'resolved' });
    return { rosterId: roster.id, at: instant.toISOString(), steps, responders, excludedForSod };
  }

  /**
   * Members on call at `at`. A member with schedule windows is on call only inside one (start
   * inclusive, end exclusive); a member without any is always on call (a static ladder).
   */
  private onCallAt(roster: OncallRoster, at: Date): OncallMember[] {
    const ms = at.getTime();
    const windows = new Map<string, OncallSchedule[]>();
    for (const window of roster.schedules) {
      windows.set(window.userId, [...(windows.get(window.userId) ?? []), window]);
    }
    return roster.members.filter((member) => {
      const own = windows.get(member.userId);
      if (own === undefined) return true;
      return own.some((w) => Date.parse(w.startsAt) <= ms && ms < Date.parse(w.endsAt));
    });
  }

  private async recordSodSkip(
    tenantId: string,
    runId: string,
    rosterId: string,
    level: number,
    onCall: readonly OncallMember[],
  ): Promise<void> {
    this.deps.metrics.sodSkips.inc();
    this.deps.logger.warn({ tenantId, runId, level }, 'oncall.sod_skipped');
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    const record: AuditEventInput = {
      action: 'oncall.sod_skipped',
      tenantId,
      actor: { type: 'system' },
      target: { type: 'run', id: runId },
      outcome: 'success',
      occurredAt: this.clock.now().toISOString(),
      ...(traceId === undefined ? {} : { traceId }),
      metadata: {
        rosterId,
        level,
        membersAtLevel: onCall.filter((m) => m.level === level).length,
      },
    };
    // A failed audit append must not stop the page: the skip itself is already the safe outcome.
    await this.append(record);
  }

  private async append(record: AuditEventInput): Promise<void> {
    try {
      await this.deps.audit.append(record);
    } catch (err) {
      this.deps.metrics.auditFailures.inc({ action: record.action });
      this.deps.logger.error({ action: record.action, err }, 'oncall audit append failed');
    }
  }

  private authorise(
    principal: OncallPrincipal,
    permission: 'settings:read' | 'settings:write',
  ): string {
    if (principal.tenantId === null || principal.tenantId.length === 0) {
      throw new AuthError('no tenant context on the authenticated principal', {
        detail: 'a tenant context is required',
      });
    }
    if (!hasPermission(principal.roles, permission)) {
      throw new ForbiddenError(`on-call rosters require ${permission} (Org Admin)`, {
        detail: `on-call rosters require ${permission} (Org Admin)`,
      });
    }
    return principal.tenantId;
  }

  private async requireRoster(tenantId: string, rosterId: string): Promise<OncallRoster> {
    const parsed = uuidV7Schema.safeParse(rosterId);
    const roster = parsed.success ? await this.deps.store.get(tenantId, parsed.data) : null;
    // Another tenant's roster and a missing one are the same answer (no existence oracle, §8.6).
    if (roster?.tenantId !== tenantId) throw new NotFoundError('on-call roster not found');
    return roster;
  }

  private parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(body)');
    throw new ValidationError('invalid on-call roster', {
      detail: `invalid fields: ${[...new Set(fields)].join(', ')}`,
    });
  }

  /** Assembles the stored roster from a validated request, reading wall-clock windows in the roster zone. */
  private build(args: {
    readonly id: string;
    readonly tenantId: string;
    readonly request: OncallRosterCreate;
    readonly stateVersion: number;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly existingMembers: readonly OncallMember[];
  }): OncallRoster {
    const { request } = args;
    const memberIds = new Set(request.members.map((m) => m.userId.toLowerCase()));
    const members: OncallMember[] = request.members.map((m) => ({
      // A member that stays on the same seat keeps its id, so audit and links stay stable.
      id:
        args.existingMembers.find((e) => e.userId === m.userId && e.level === m.level)?.id ??
        this.nextId(),
      userId: m.userId,
      level: m.level,
      orderIndex: m.orderIndex,
      channelRefs: [...m.channelRefs],
    }));
    const schedules = request.schedules.map((w, index) =>
      this.window(w, request.timezone, index, memberIds),
    );
    const candidate = {
      id: args.id,
      tenantId: args.tenantId,
      name: request.name,
      timezone: request.timezone,
      active: request.active,
      stateVersion: args.stateVersion,
      members,
      schedules,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    };
    const checked = oncallRosterSchema.safeParse(candidate);
    if (!checked.success) {
      const fields = checked.error.issues.map((issue) => issue.path.join('.') || '(body)');
      throw new ValidationError('invalid on-call roster', {
        detail: `invalid fields: ${[...new Set(fields)].join(', ')}`,
      });
    }
    return checked.data;
  }

  private window(
    input: OncallScheduleInput,
    timezone: string,
    index: number,
    memberIds: ReadonlySet<string>,
  ): OncallSchedule {
    if (!memberIds.has(input.userId.toLowerCase())) {
      throw new ValidationError('a schedule window names someone who is not a member', {
        detail: `schedules.${String(index)}.userId is not a member of the roster`,
      });
    }
    return {
      id: this.nextId(),
      userId: input.userId,
      startsAt: boundaryToInstant(
        input.startsAt,
        timezone,
        `schedules.${String(index)}.startsAt`,
      ).toISOString(),
      endsAt: boundaryToInstant(
        input.endsAt,
        timezone,
        `schedules.${String(index)}.endsAt`,
      ).toISOString(),
    };
  }

  private conflict(reason: OncallConflictReason): ConflictError {
    return new ConflictError(CONFLICT_DETAIL[reason], { detail: CONFLICT_DETAIL[reason] });
  }

  private stale(): PreconditionFailedError {
    // Same answer as a failed If-Match: the row changed (or vanished) between the read and the write.
    return new PreconditionFailedError(
      'The resource was modified or deleted concurrently; re-fetch it and retry.',
      {
        detail: 'The resource was modified or deleted concurrently; re-fetch it and retry.',
      },
    );
  }
}

function isNonEmpty(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The audit event of a roster write, committed with it (`oncall.roster.updated`). Metadata carries
 * references and counts only: no name, e-mail or channel contents (§8.6 privacy).
 */
function rosterAudit(
  principal: OncallPrincipal,
  roster: OncallRoster,
  change: 'created' | 'updated',
  traceId: string | null,
): AuditEventInput {
  return {
    action: 'oncall.roster.updated',
    tenantId: roster.tenantId,
    actor: actorOf(principal),
    target: { type: 'config', id: roster.id },
    outcome: 'success',
    occurredAt: roster.updatedAt,
    ...(traceId === null ? {} : { traceId }),
    metadata: {
      rosterId: roster.id,
      change,
      active: roster.active,
      timezone: roster.timezone,
      stateVersion: roster.stateVersion,
      members: roster.members.length,
      schedules: roster.schedules.length,
    },
  };
}
