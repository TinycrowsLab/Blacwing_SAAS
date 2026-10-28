import {
  type EffectivePersonaSettings,
  isPersonaName,
  parsePersonaOverride,
  type PersonaDefinition,
  PersonaError,
  type PersonaName,
  type PersonaOverride,
  PERSONA_OVERRIDE_FIELDS,
  resolveEffectivePersona,
} from '@blackwing/agents';
import { hasPermission } from '@blackwing/domain';
import { AppError, ForbiddenError } from '@blackwing/errors';

import type { PersonaOverrideMetrics } from './metrics.js';
import type {
  PersonaAuditWriter,
  PersonaOverrideColumns,
  PersonaOverrideStore,
  PersonaPrincipal,
  PersonaWarnSink,
  StoredPersonaOverride,
} from './ports.js';
import type { AuditMetadata, Permission } from '@blackwing/contracts';

/** The audit action recorded for every change to a tenant's persona override (§8.8). */
export const PERSONA_OVERRIDE_CHANGED_ACTION = 'persona.override_changed';

/** The override a tenant has set for one persona, as the API shows it. `override` is null when none is set. */
export interface PersonaOverrideView {
  readonly persona: PersonaName;
  readonly override: PersonaOverride | null;
  /** ISO-8601 time of the last change; null when no override has ever been set. */
  readonly updatedAt: string | null;
}

export interface PersonaOverrideServiceDeps<Tx> {
  readonly store: PersonaOverrideStore<Tx>;
  readonly writeAudit: PersonaAuditWriter<Tx>;
  readonly metrics: PersonaOverrideMetrics;
  readonly logger?: PersonaWarnSink;
}

/** RBAC permissions: org_admin holds both; no other tenant role can read or change an override. */
const READ_PERMISSION: Permission = 'settings:read';
const WRITE_PERMISSION: Permission = 'settings:write';

/** The tenant of the caller. A caller without one fails closed (`TENANT_CONTEXT_MISSING`, 403). */
function requireTenant(principal: PersonaPrincipal): string {
  if (principal.tenantId === null) {
    throw new AppError('TENANT_CONTEXT_MISSING', 'no tenant context for the persona override');
  }
  return principal.tenantId;
}

function requirePermission(principal: PersonaPrincipal, permission: Permission): void {
  if (!hasPermission(principal.roles, permission)) {
    throw new ForbiddenError(`${permission} is required`, {
      detail: `this action requires ${permission}`,
    });
  }
}

/** Longest untrusted persona name echoed back in an error message. */
const MAX_ECHOED_PERSONA_LENGTH = 80;

/** A persona name outside the fixed roster is refused before any storage is touched (422). */
function requireRosterName(persona: string): PersonaName {
  if (!isPersonaName(persona)) {
    throw new PersonaError(
      'PERSONA_UNKNOWN',
      `PERSONA_UNKNOWN: ${JSON.stringify(persona).slice(0, MAX_ECHOED_PERSONA_LENGTH)}`,
    );
  }
  return persona;
}

function columnsOf(override: PersonaOverride): PersonaOverrideColumns {
  return {
    effort: override.effort ?? null,
    maxTurns: override.maxTurns ?? null,
    maxBudgetUsd: override.maxBudgetUsd ?? null,
    lowerStandardTier: override.lowerStandardTier ?? null,
  };
}

/** The body a stored row stands for: only the fields the tenant set. Re-validated on every read. */
function bodyOf(columns: PersonaOverrideColumns): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (columns.effort !== null) body.effort = columns.effort;
  if (columns.maxTurns !== null) body.maxTurns = columns.maxTurns;
  if (columns.maxBudgetUsd !== null) body.maxBudgetUsd = columns.maxBudgetUsd;
  if (columns.lowerStandardTier !== null) body.lowerStandardTier = columns.lowerStandardTier;
  return body;
}

function overrideOf(stored: PersonaOverrideColumns): PersonaOverride {
  return parsePersonaOverride(bodyOf(stored));
}

function viewOf(persona: PersonaName, stored: StoredPersonaOverride | null): PersonaOverrideView {
  if (stored === null) return { persona, override: null, updatedAt: null };
  return {
    persona,
    override: overrideOf(stored),
    updatedAt: stored.updatedAt.toISOString(),
  };
}

/**
 * Tenant persona overrides (REGISTRY-010, §4.6 / §8.11). Reads and writes are RBAC-gated (`settings:read`
 * for reads, `settings:write`, held by org_admin only, for writes). A write and its audit event commit
 * together. Resolution merges the override into the base definition at run start.
 */
export class PersonaOverrideService<Tx> {
  constructor(private readonly deps: PersonaOverrideServiceDeps<Tx>) {}

  /** The override a tenant has set for `persona`. */
  async get(principal: PersonaPrincipal, persona: string): Promise<PersonaOverrideView> {
    const tenantId = requireTenant(principal);
    requirePermission(principal, READ_PERMISSION);
    const name = requireRosterName(persona);
    return viewOf(name, await this.deps.store.find(tenantId, name));
  }

  /**
   * Replaces the tenant's override for `persona`. The body is whitelisted: a field outside
   * {@link PERSONA_OVERRIDE_FIELDS} is refused (`OVERRIDE_FIELD_FORBIDDEN`), and an empty body resets the
   * persona to its base values. The change is audited in the same transaction.
   */
  async put(
    principal: PersonaPrincipal,
    persona: string,
    body: unknown,
  ): Promise<PersonaOverrideView> {
    const tenantId = requireTenant(principal);
    requirePermission(principal, WRITE_PERMISSION);
    const name = requireRosterName(persona);
    const override = parsePersonaOverride(body);
    const columns = columnsOf(override);

    const values: Record<string, string | number | boolean> = {};
    for (const field of PERSONA_OVERRIDE_FIELDS) {
      const value = override[field];
      if (value !== undefined) values[field] = value;
    }
    const metadata: AuditMetadata = { persona: name, fields: Object.keys(values), values };
    const actor =
      principal.type === 'service'
        ? { type: 'service' as const, id: principal.id }
        : { type: 'user' as const, id: principal.id };

    const stored = await this.deps.store.replace(tenantId, name, columns, (tx) =>
      this.deps.writeAudit(tx, {
        tenantId,
        action: PERSONA_OVERRIDE_CHANGED_ACTION,
        actor,
        target: { type: 'config', id: `persona:${name}` },
        outcome: 'success',
        metadata,
      }),
    );
    return viewOf(name, stored);
  }

  /**
   * The effective settings of `definition` for `tenantId`: the base definition with the tenant's override
   * merged in (override precedence, clamped to the persona's own bounds). Called at run start, so the
   * result is what a run pins. A persona with no override resolves to its base values.
   */
  async resolveEffective(
    tenantId: string,
    definition: PersonaDefinition,
  ): Promise<EffectivePersonaSettings> {
    const stored = await this.deps.store.find(tenantId, definition.name);
    const effective = resolveEffectivePersona(
      definition,
      stored === null ? null : overrideOf(stored),
    );
    for (const clamp of effective.clamped) {
      this.deps.logger?.warn(
        {
          persona: definition.name,
          field: clamp.field,
          requested: clamp.requested,
          applied: clamp.applied,
        },
        'persona override clamped to the persona bound',
      );
    }
    for (const field of effective.overridden) {
      this.deps.metrics.applied.inc({ persona: definition.name, field });
    }
    return effective;
  }
}
