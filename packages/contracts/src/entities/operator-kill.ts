import { z } from 'zod';

import { LIMITS } from '../limits.js';
import { KILL_REASON_MIN, killAffectedSchema, killEventStatusSchema } from './kill.js';
import { isoDateTimeSchema, uuidV7Schema } from '../primitives.js';
import { tenantSlugSchema } from './tenancy.js';

/**
 * Platform-operator kill control contracts (F33, CONTEXT_PACK §1.2, §8.5): `/operator/v1/kill`.
 *
 * The operator console only triggers the deterministic kill path and renders its outcome (§8.11); these
 * schemas are the wire contract between that console, the operator API and the tests of both.
 */

/** Scopes the operator endpoint accepts. `run` and `asset` kills belong to the tenant API and live view. */
export const OPERATOR_KILL_SCOPES = ['global', 'tenant'] as const;
export const operatorKillScopeSchema = z.enum(OPERATOR_KILL_SCOPES);
export type OperatorKillScope = z.infer<typeof operatorKillScopeSchema>;

interface ScopeAndTenant {
  readonly scope: OperatorKillScope;
  readonly tenantId?: string | undefined;
}

/** A tenant kill names its tenant; a global kill names none. */
function checkTenantMatchesScope(value: ScopeAndTenant, ctx: z.RefinementCtx): void {
  if (value.scope === 'tenant' && value.tenantId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['tenantId'],
      message: 'a tenant kill must name the tenant',
    });
  }
  if (value.scope === 'global' && value.tenantId !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['tenantId'],
      message: 'a global kill must not name a tenant',
    });
  }
}

/** Query of `GET /operator/v1/kill/blast-radius`. */
export const operatorBlastRadiusQuerySchema = z
  .strictObject({ scope: operatorKillScopeSchema, tenantId: uuidV7Schema.optional() })
  .superRefine(checkTenantMatchesScope);

const count = z.int().nonnegative();

/**
 * What a kill would stop right now. `tenantSlug` is present for a tenant scope: it is what the operator
 * types to confirm, and proves the id names a real tenant.
 */
export const operatorBlastRadiusSchema = z.strictObject({
  runsAffected: count,
  sandboxesAffected: count,
  tenantsAffected: count,
  sessionsAffected: count,
  tenantSlug: tenantSlugSchema.optional(),
});
export type OperatorBlastRadius = z.infer<typeof operatorBlastRadiusSchema>;

/** Body of `POST /operator/v1/kill`. */
export const operatorKillRequestSchema = z
  .strictObject({
    scope: operatorKillScopeSchema,
    tenantId: uuidV7Schema.optional(),
    reason: z
      .string()
      .max(LIMITS.reasonMax)
      .refine((value) => value.trim().length >= KILL_REASON_MIN, {
        message: `must be at least ${String(KILL_REASON_MIN)} characters`,
      }),
  })
  .superRefine(checkTenantMatchesScope);
export type OperatorKillRequest = z.infer<typeof operatorKillRequestSchema>;

/** One prior kill in `GET /operator/v1/kill/events`. `tenantId` is null for a global kill. */
export const operatorKillEventSummarySchema = z.strictObject({
  id: uuidV7Schema,
  scope: operatorKillScopeSchema,
  tenantId: uuidV7Schema.nullable(),
  actor: z.string().min(1).max(LIMITS.subjectMax),
  reason: z.string().min(1).max(LIMITS.reasonMax),
  firedAt: isoDateTimeSchema,
  haltMs: z.int().nonnegative().nullable(),
  status: killEventStatusSchema,
});
export type OperatorKillEventSummary = z.infer<typeof operatorKillEventSummarySchema>;

export const operatorKillEventListSchema = z.strictObject({
  items: z.array(operatorKillEventSummarySchema),
});
export type OperatorKillEventList = z.infer<typeof operatorKillEventListSchema>;

/**
 * One kill with its phase timestamps and per-component results (`GET /operator/v1/kill/events/{id}`).
 * A phase timestamp is null until the kill path confirmed that phase: the console never infers one.
 */
export const operatorKillEventDetailSchema = operatorKillEventSummarySchema.extend({
  egressBlockedAt: isoDateTimeSchema.nullable(),
  sandboxesTerminatedAt: isoDateTimeSchema.nullable(),
  keysRevokedAt: isoDateTimeSchema.nullable(),
  workflowsCancelledAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  affected: killAffectedSchema,
});
export type OperatorKillEventDetail = z.infer<typeof operatorKillEventDetailSchema>;

/** Statuses in which propagation is still running. */
const KILL_OPEN_STATUSES = ['initiated', 'propagating'] as const;

/** True while the kill path has not reached a final status. */
export function isKillOpen(status: z.infer<typeof killEventStatusSchema>): boolean {
  return (KILL_OPEN_STATUSES as readonly string[]).includes(status);
}

/** The phases the console renders, in the order §8.5 executes them. */
export const KILL_PHASES = [
  { key: 'gateway', label: 'Gateway blocked', field: 'egressBlockedAt' },
  { key: 'sandboxes', label: 'Sandboxes terminated', field: 'sandboxesTerminatedAt' },
  { key: 'keys', label: 'Keys revoked', field: 'keysRevokedAt' },
  { key: 'workflows', label: 'Workflows cancelled', field: 'workflowsCancelledAt' },
] as const;

/** §8.5 targets, p99: the gateway blocks within 2 s, sandboxes are gone within 10 s. */
export const KILL_SLA_GATEWAY_MS = 2000;
export const KILL_SLA_SANDBOX_MS = 10_000;

/** Which §8.5 targets one kill exceeded. A phase that has not completed cannot have breached yet. */
export function killSlaBreaches(
  event: Pick<OperatorKillEventDetail, 'firedAt' | 'egressBlockedAt' | 'sandboxesTerminatedAt'>,
): { readonly gateway: boolean; readonly sandboxes: boolean } {
  const fired = Date.parse(event.firedAt);
  const exceeded = (at: string | null, limitMs: number): boolean =>
    at !== null && Date.parse(at) - fired > limitMs;
  return {
    gateway: exceeded(event.egressBlockedAt, KILL_SLA_GATEWAY_MS),
    sandboxes: exceeded(event.sandboxesTerminatedAt, KILL_SLA_SANDBOX_MS),
  };
}

/** A component the kill could not stop, e.g. `sandbox sbx-1`. */
export interface KillFailedComponent {
  readonly kind: 'egress' | 'sandbox' | 'key' | 'workflow';
  readonly id: string;
}

/** Every component whose result is `failed`: a partial kill must name them, never hide them (§8.5). */
export function killFailedComponents(
  affected: z.infer<typeof killAffectedSchema>,
): readonly KillFailedComponent[] {
  return [
    ...(affected.egress ?? [])
      .filter((r) => r.outcome === 'failed')
      .map((r): KillFailedComponent => ({ kind: 'egress', id: r.identity })),
    ...(affected.sandboxResults ?? [])
      .filter((r) => r.outcome === 'failed')
      .map((r): KillFailedComponent => ({ kind: 'sandbox', id: r.sandboxId })),
    ...(affected.keyResults ?? [])
      .filter((r) => r.outcome === 'failed')
      .map((r): KillFailedComponent => ({ kind: 'key', id: r.keyId })),
    ...(affected.workflowResults ?? [])
      .filter((r) => r.outcome === 'failed')
      .map((r): KillFailedComponent => ({ kind: 'workflow', id: r.workflowId })),
  ];
}

/**
 * The phrase an operator must type before a kill can fire: `GLOBAL`, or `KILL <slug>` for one tenant.
 * Exact and case-sensitive on purpose; `tenantRef` is the tenant slug; when it is not known (blast radius unavailable) the
 * tenant id stands in for it so an emergency kill is never blocked by a missing preview.
 */
export function killConfirmationPhrase(scope: OperatorKillScope, tenantRef: string): string {
  return scope === 'global' ? 'GLOBAL' : `KILL ${tenantRef}`;
}

/** True when what was typed (surrounding whitespace ignored) is exactly the expected phrase. */
export function matchesKillConfirmation(typed: string, expected: string): boolean {
  return expected.length > 0 && typed.trim() === expected;
}
