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
