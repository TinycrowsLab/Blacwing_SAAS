import { Counter, Registry } from 'prom-client';

/** Persona override metrics (REGISTRY-010 observability). One private registry per instance. */
export interface PersonaOverrideMetrics {
  readonly registry: Registry;
  /** `persona_override_applied_total{persona,field}`: a whitelisted override field is in effect for a run. */
  readonly applied: Counter<'persona' | 'field'>;
}

export function createPersonaOverrideMetrics(
  registry: Registry = new Registry(),
): PersonaOverrideMetrics {
  return {
    registry,
    applied: new Counter({
      name: 'persona_override_applied_total',
      help: 'Whitelisted persona override fields in effect when a run resolved its persona settings.',
      labelNames: ['persona', 'field'],
      registers: [registry],
    }),
  };
}

/** Persona registry read metrics (REGISTRY-011 observability). */
export interface PersonaRegistryMetrics {
  readonly registry: Registry;
  /** `persona_registry_reads_total{operation}`: an authorised registry read (`list` or `get`). */
  readonly reads: Counter<'operation'>;
}

export function createPersonaRegistryMetrics(
  registry: Registry = new Registry(),
): PersonaRegistryMetrics {
  return {
    registry,
    reads: new Counter({
      name: 'persona_registry_reads_total',
      help: 'Authorised reads of the persona registry, by operation (list or get).',
      labelNames: ['operation'],
      registers: [registry],
    }),
  };
}
