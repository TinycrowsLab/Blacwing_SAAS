import {
  loadPersona,
  type EffectivePersonaSettings,
  type EffortLevel,
  type ModelProvider,
  type PersonaDefinition,
  type PersonaName,
  type PersonaOverrideField,
  PERSONA_NAMES,
  resolveTier,
  type TierAlias,
} from '@blackwing/agents';

import {
  requirePermission,
  type PersonaOverrideService,
  requireRosterName,
  requireTenant,
} from './service.js';

import type { PersonaRegistryMetrics } from './metrics.js';
import type { PersonaPrincipal } from './ports.js';
import type { Permission } from '@blackwing/contracts';

/**
 * The persona registry read API (REGISTRY-011, CONTEXT_PACK §4.6 / §8.9). Lists and gets the persona definitions
 * with the settings a run of the caller's tenant would pin: the base definition with the tenant override merged in
 * (the same merge a run uses, without its side effects). The view is an explicit allowlist, so a field added to a
 * definition later never reaches a caller unless it is added here on purpose.
 *
 * Every tenant role holds `run:read` (CONTEXT_PACK §1.2), so that is the viewer+ gate: no tenant member is refused
 * and no unauthenticated or tenant-less caller is served.
 */

/** The permission every tenant role holds; the registry is readable by any tenant member. */
export const PERSONA_REGISTRY_READ_PERMISSION: Permission = 'run:read';

/** A native helper a persona may spawn, as the registry shows it. */
export interface PersonaRegistryHelperView {
  readonly name: string;
  readonly description: string;
  readonly tierAlias: TierAlias;
  readonly allowedTools: readonly string[];
}

/** One persona definition with the tenant's effective settings. */
export interface PersonaRegistryView {
  readonly name: PersonaName;
  readonly mandate: string;
  /** The prompt version the persona runs (`promptRef.version`); the prompt body is pinned by hash elsewhere. */
  readonly promptVersion: string;
  readonly tierAlias: TierAlias;
  /** The settings a run of this tenant pins: the resolved model and the effective effort and budgets. */
  readonly effective: {
    readonly model: string;
    readonly effort: EffortLevel;
    readonly maxTurns: number;
    readonly maxBudgetUsd: number;
  };
  /** Override fields in effect for this tenant; empty when the base values apply. */
  readonly overridden: readonly PersonaOverrideField[];
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly declaredOracleTypes: PersonaDefinition['declaredOracleTypes'];
  readonly inputs: readonly string[];
  readonly intrusivenessCeiling: PersonaDefinition['intrusivenessCeiling'];
  readonly requiresSubmission: boolean;
  readonly helpers: readonly PersonaRegistryHelperView[];
}

export interface PersonaRegistryList {
  readonly items: readonly PersonaRegistryView[];
}

export interface PersonaRegistryServiceDeps<Tx> {
  readonly overrides: PersonaOverrideService<Tx>;
  /** The provider whose model IDs the view resolves to (`resolveTier`); tenant routing supplies it. */
  readonly provider: ModelProvider;
  readonly metrics: PersonaRegistryMetrics;
}

function viewOf(
  definition: PersonaDefinition,
  settings: EffectivePersonaSettings,
  provider: ModelProvider,
): PersonaRegistryView {
  return {
    name: definition.name,
    mandate: definition.mandate,
    promptVersion: definition.promptRef.version,
    tierAlias: definition.tierAlias,
    effective: {
      model: resolveTier(settings.tierAlias, provider, settings.evalFlags),
      effort: settings.effort,
      maxTurns: settings.maxTurns,
      maxBudgetUsd: settings.maxBudgetUsd,
    },
    overridden: settings.overridden,
    allowedTools: definition.allowedTools,
    disallowedTools: definition.disallowedTools,
    declaredOracleTypes: definition.declaredOracleTypes,
    inputs: definition.inputs,
    intrusivenessCeiling: definition.intrusivenessCeiling,
    requiresSubmission: definition.requiresSubmission,
    helpers: (definition.helpers ?? []).map((helper) => ({
      name: helper.name,
      description: helper.description,
      tierAlias: helper.tierAlias,
      allowedTools: helper.allowedTools,
    })),
  };
}

/** Read access to the persona registry for the caller's tenant. */
export class PersonaRegistryService<Tx> {
  constructor(private readonly deps: PersonaRegistryServiceDeps<Tx>) {}

  /** Every persona of the fixed roster, in roster order, with the caller tenant's effective settings. */
  async list(principal: PersonaPrincipal): Promise<PersonaRegistryList> {
    const tenantId = requireTenant(principal);
    requirePermission(principal, PERSONA_REGISTRY_READ_PERMISSION);
    this.deps.metrics.reads.inc({ operation: 'list' });
    const items: PersonaRegistryView[] = [];
    for (const name of PERSONA_NAMES) {
      items.push(await this.view(tenantId, loadPersona(name)));
    }
    return { items };
  }

  /** One persona of the roster with the caller tenant's effective settings. */
  async get(principal: PersonaPrincipal, persona: string): Promise<PersonaRegistryView> {
    const tenantId = requireTenant(principal);
    requirePermission(principal, PERSONA_REGISTRY_READ_PERMISSION);
    const name = requireRosterName(persona);
    this.deps.metrics.reads.inc({ operation: 'get' });
    return this.view(tenantId, loadPersona(name));
  }

  private async view(
    tenantId: string,
    definition: PersonaDefinition,
  ): Promise<PersonaRegistryView> {
    const settings = await this.deps.overrides.readEffective(tenantId, definition);
    return viewOf(definition, settings, this.deps.provider);
  }
}
