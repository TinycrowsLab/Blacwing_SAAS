import { z } from 'zod';

import { LIMITS } from '../limits.js';
import {
  checkTimestamps,
  isoDateTimeSchema,
  labelSchema,
  sha256HexSchema,
  timestampsShape,
  uuidV7Schema,
} from '../primitives.js';

/**
 * Kill-switch persistence contracts (KILL-001, F33, CONTEXT_PACK §7 `kill_events`, §8.5).
 *
 * The value lists below are the single source for the Postgres check constraints in `@blackwing/db`.
 * Every refinement here mirrors a constraint in the migration, so a row the database accepts parses
 * and a payload the database would reject fails here first.
 */

/** What a kill stops: one run, one asset, a whole tenant, or the whole platform (§8.5). */
export const KILL_SCOPES = ['run', 'asset', 'tenant', 'global'] as const;
export const killScopeSchema = z.enum(KILL_SCOPES);
export type KillScope = z.infer<typeof killScopeSchema>;

/** Scopes that name a single run or asset and therefore need `scopeRefId`. */
export const KILL_SCOPES_WITH_REF = ['run', 'asset'] as const satisfies readonly KillScope[];

/** Where a kill was triggered from. */
export const KILL_SOURCES = ['console', 'api', 'soc_link', 'operator', 'system'] as const;
export const killSourceSchema = z.enum(KILL_SOURCES);
export type KillSource = z.infer<typeof killSourceSchema>;

/** Propagation status of a kill event. */
export const KILL_EVENT_STATUSES = [
  'initiated',
  'propagating',
  'halted',
  'partially_halted',
  'failed',
] as const;
export const killEventStatusSchema = z.enum(KILL_EVENT_STATUSES);
export type KillEventStatus = z.infer<typeof killEventStatusSchema>;

/** Scopes a login-free SOC kill link may carry: never `global` (that is a platform-operator action). */
export const SOC_KILL_TOKEN_SCOPES = [
  'run',
  'asset',
  'tenant',
] as const satisfies readonly KillScope[];
export const socKillTokenScopeSchema = z.enum(SOC_KILL_TOKEN_SCOPES);
export type SocKillTokenScope = z.infer<typeof socKillTokenScopeSchema>;

/** `soc_contacts.status`. */
export const SOC_CONTACT_STATUSES = ['active', 'disabled'] as const;
export const socContactStatusSchema = z.enum(SOC_CONTACT_STATUSES);
export type SocContactStatus = z.infer<typeof socContactStatusSchema>;

/** Per-identity result of the egress block stage (KILL-004), keyed `run:<id>` or `principal:<tc_..role_..>`. */
export const KILL_EGRESS_OUTCOMES = ['blocked', 'already_blocked', 'failed'] as const;
export const killEgressOutcomeSchema = z.enum(KILL_EGRESS_OUTCOMES);
export type KillEgressOutcome = z.infer<typeof killEgressOutcomeSchema>;

/** Per-sandbox result of the sandbox terminate stage (KILL-005). `terminating` = the controller's finalizer owns it. */
export const KILL_SANDBOX_OUTCOMES = [
  'terminated',
  'already_gone',
  'terminating',
  'failed',
] as const;
export const killSandboxOutcomeSchema = z.enum(KILL_SANDBOX_OUTCOMES);
export type KillSandboxOutcome = z.infer<typeof killSandboxOutcomeSchema>;

/** Counts of what a kill touched (`kill_events.affected`), plus the per-identity egress outcome. */
export const killAffectedSchema = z.strictObject({
  egress: z
    .array(
      z.strictObject({
        identity: z.string().min(1).max(LIMITS.subjectMax),
        outcome: killEgressOutcomeSchema,
      }),
    )
    .optional(),
  runs: z.int().nonnegative().optional(),
  sessions: z.int().nonnegative().optional(),
  sandboxes: z.int().nonnegative().optional(),
  sandboxResults: z
    .array(
      z.strictObject({
        sandboxId: z.string().min(1).max(LIMITS.subjectMax),
        outcome: killSandboxOutcomeSchema,
      }),
    )
    .optional(),
  keys: z.int().nonnegative().optional(),
  workflows: z.int().nonnegative().optional(),
});
export type KillAffected = z.infer<typeof killAffectedSchema>;

/**
 * The counter contract for kill events: `bw_kill_events_total{scope,source,status}`. Defined here, incremented
 * by the kill service (KILL-003 onwards) whenever a kill event is created or changes status.
 */
export const KILL_EVENTS_TOTAL_METRIC = Object.freeze({
  name: 'bw_kill_events_total',
  type: 'counter',
  help: 'Kill-switch events by scope and status',
  labels: Object.freeze(['scope', 'source', 'status'] as const),
} as const);

type RefinementContext = z.RefinementCtx;

function checkScopeRef(
  value: { scope: KillScope; scopeRefId: string | null },
  ctx: RefinementContext,
): void {
  const needsRef = (KILL_SCOPES_WITH_REF as readonly string[]).includes(value.scope);
  if (needsRef && value.scopeRefId === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeRefId'],
      message: `a ${value.scope} kill must name the ${value.scope} it stops`,
    });
  }
  if (!needsRef && value.scopeRefId !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['scopeRefId'],
      message: `a ${value.scope} kill must not carry a scopeRefId`,
    });
  }
}

/**
 * A kill-switch ledger row, §7 `kill_events`.
 *
 * `tenantId` is null only for a `global` (platform-operator) event; such rows are invisible to the
 * tenant RLS policy and are written and read only through the operator role. Halt timings are
 * server-generated; `haltMs` is computed by the kill service, never taken from client input.
 */
export const killEventSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema.nullable(),
    scope: killScopeSchema,
    scopeRefId: uuidV7Schema.nullable(),
    source: killSourceSchema,
    actorType: z.string().min(1).max(LIMITS.keyMax),
    actorRef: z.string().min(1).max(LIMITS.subjectMax),
    reason: z
      .string()
      .max(LIMITS.reasonMax)
      .refine((value) => value.trim().length > 0, 'must not be blank'),
    status: killEventStatusSchema,
    triggeredAt: isoDateTimeSchema,
    egressBlockedAt: isoDateTimeSchema.nullable(),
    sandboxesTerminatedAt: isoDateTimeSchema.nullable(),
    keysRevokedAt: isoDateTimeSchema.nullable(),
    workflowsCancelledAt: isoDateTimeSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    haltMs: z.int().nonnegative().max(LIMITS.int32Max).nullable(),
    affected: killAffectedSchema,
    reenabledAt: isoDateTimeSchema.nullable(),
    reenabledBy: uuidV7Schema.nullable(),
    ...timestampsShape,
  })
  .superRefine((event, ctx) => {
    checkTimestamps(event, ctx);
    checkScopeRef(event, ctx);
    if (event.tenantId === null && event.scope !== 'global') {
      ctx.addIssue({
        code: 'custom',
        path: ['tenantId'],
        message: 'only a global kill event may have no tenant',
      });
    }
    if ((event.reenabledAt === null) !== (event.reenabledBy === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reenabledBy'],
        message: 'reenabledAt and reenabledBy are set together',
      });
    }
  });
export type KillEvent = z.infer<typeof killEventSchema>;

/** A locale tag such as `en` or `en-GB`. */
const localeSchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'must be a BCP 47 tag');

/**
 * A SOC contact, §7 `soc_contacts` (F33): who is told about test windows and receives a kill link.
 * `assetId` null means the contact covers the whole tenant. Email and phone are PII: never log them.
 */
export const socContactSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    assetId: uuidV7Schema.nullable(),
    name: labelSchema,
    email: z.email().max(LIMITS.emailMax),
    phone: z
      .string()
      .regex(/^\+?[0-9 ()-]{3,32}$/, 'must be a phone number')
      .nullable(),
    notifyPrewindow: z.boolean(),
    notifyStart: z.boolean(),
    notifyEnd: z.boolean(),
    locale: localeSchema,
    status: socContactStatusSchema,
    ...timestampsShape,
  })
  .superRefine((contact, ctx) => {
    checkTimestamps(contact, ctx);
  });
export type SocContact = z.infer<typeof socContactSchema>;

/**
 * A login-free SOC kill-link token, §7 `soc_kill_tokens`. Only the SHA-256 of the raw token is stored
 * (as with `api_tokens`); the raw token exists only in the link sent to the SOC contact.
 */
export const socKillTokenSchema = z
  .strictObject({
    id: uuidV7Schema,
    tenantId: uuidV7Schema,
    scope: socKillTokenScopeSchema,
    scopeRefId: uuidV7Schema.nullable(),
    tokenSha256: sha256HexSchema,
    contactId: uuidV7Schema.nullable(),
    expiresAt: isoDateTimeSchema,
    maxUses: z.int().min(1).max(LIMITS.killTokenUsesMax),
    useCount: z.int().nonnegative(),
    lastUsedAt: isoDateTimeSchema.nullable(),
    revokedAt: isoDateTimeSchema.nullable(),
    ...timestampsShape,
  })
  .superRefine((token, ctx) => {
    checkTimestamps(token, ctx);
    checkScopeRef(token, ctx);
    if (token.useCount > token.maxUses) {
      ctx.addIssue({
        code: 'custom',
        path: ['useCount'],
        message: 'a kill token cannot be used more often than maxUses',
      });
    }
    if (token.useCount > 0 && token.lastUsedAt === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['lastUsedAt'],
        message: 'a used kill token records when it was last used',
      });
    }
  });
export type SocKillToken = z.infer<typeof socKillTokenSchema>;

/** An opaque id from another system (SDK session, sandbox, virtual key, Temporal workflow). */
const killTargetRefSchema = z.string().min(1).max(LIMITS.subjectMax);

/** A per-session egress proxy principal, `tc_<testCaseId>.role_<roleId>` (§4.1). */
export const KILL_PROXY_PRINCIPAL_PATTERN = /^tc_[0-9a-z-]{1,64}\.role_[0-9a-z-]{1,64}$/;

/**
 * An identity the egress gateway blocks on a kill (KILL-002, §4.1): the run-keyed gateway identity,
 * or one session's proxy principal inside that run.
 */
export const killEgressIdentitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run'), runId: uuidV7Schema }),
  z.strictObject({
    kind: z.literal('proxy_principal'),
    runId: uuidV7Schema,
    sessionId: killTargetRefSchema,
    principal: z.string().regex(KILL_PROXY_PRINCIPAL_PATTERN, 'must be tc_<id>.role_<id>'),
  }),
]);
export type KillEgressIdentity = z.infer<typeof killEgressIdentitySchema>;

/**
 * Everything one kill must stop (KILL-002, §8.5): produced by `resolveKillTargets` in
 * `@blackwing/domain` and consumed by the propagation coordinator (KILL-004/005/006). Ids only; every
 * list is de-duplicated and sorted so the same database state always yields the same set.
 */
export const killTargetSetSchema = z.strictObject({
  runIds: z.array(uuidV7Schema),
  sessionIds: z.array(killTargetRefSchema),
  sandboxIds: z.array(killTargetRefSchema),
  virtualKeyIds: z.array(killTargetRefSchema),
  egressIdentities: z.array(killEgressIdentitySchema),
  workflowIds: z.array(killTargetRefSchema),
});
export type KillTargetSet = z.infer<typeof killTargetSetSchema>;

/**
 * Scopes the tenant kill endpoint `POST /v1/kill` accepts (KILL-003). `global` is a platform-operator
 * action with its own path (KILL-013) and is refused there with `KILL_GLOBAL_NOT_ALLOWED_HERE`.
 */
export const KILL_API_SCOPES = ['run', 'asset', 'tenant'] as const satisfies readonly KillScope[];
export const killApiScopeSchema = z.enum(KILL_API_SCOPES);
export type KillApiScope = z.infer<typeof killApiScopeSchema>;

/** Shortest accepted kill reason, in characters after trimming. */
export const KILL_REASON_MIN = 3;

/**
 * Body of `POST /v1/kill`. `scopeRefId` names the run or asset for `run`/`asset` scopes and must be
 * absent for `tenant` (the tenant is the caller's own). The API maps each failure to its stable code.
 */
export const killTriggerRequestSchema = z.strictObject({
  scope: killApiScopeSchema,
  scopeRefId: uuidV7Schema.optional(),
  reason: z
    .string()
    .max(LIMITS.reasonMax)
    .refine((value) => value.trim().length >= KILL_REASON_MIN, {
      message: `must be at least ${String(KILL_REASON_MIN)} characters`,
    }),
});
export type KillTriggerRequest = z.infer<typeof killTriggerRequestSchema>;

/** `202 Accepted` body of `POST /v1/kill`. `status` is `halted` when there was nothing to stop. */
export const killTriggerResponseSchema = z.strictObject({
  killEventId: uuidV7Schema,
  status: killEventStatusSchema,
  triggeredAt: isoDateTimeSchema,
});
export type KillTriggerResponse = z.infer<typeof killTriggerResponseSchema>;

/** Shortest accepted `Idempotency-Key`, so clients cannot collide by accident. */
export const IDEMPOTENCY_KEY_MIN = 8;

/**
 * An `Idempotency-Key` header value (§9): 8 to 255 visible ASCII characters. Long enough that a
 * client cannot collide by accident, short enough to index.
 */
export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN)
  .max(LIMITS.subjectMax)
  .regex(/^[\x21-\x7e]+$/, 'must be visible ASCII');
