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

/** Counts of what a kill touched (`kill_events.affected`). */
export const killAffectedSchema = z.strictObject({
  runs: z.int().nonnegative().optional(),
  sessions: z.int().nonnegative().optional(),
  sandboxes: z.int().nonnegative().optional(),
  keys: z.int().nonnegative().optional(),
  workflows: z.int().nonnegative().optional(),
});
export type KillAffected = z.infer<typeof killAffectedSchema>;

/**
 * The counter contract for kill events: `bw_kill_events_total{scope,status}`. Defined here, incremented
 * by the kill service (KILL-003 onwards) whenever a kill event is created or changes status.
 */
export const KILL_EVENTS_TOTAL_METRIC = Object.freeze({
  name: 'bw_kill_events_total',
  type: 'counter',
  help: 'Kill-switch events by scope and status',
  labels: Object.freeze(['scope', 'status'] as const),
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
