import { Counter, Gauge, Registry } from 'prom-client';

/** Virtual-key metrics (GATEWAY-002 observability). One private registry per instance. */
export interface VirtualKeyMetrics {
  readonly registry: Registry;
  /** `bw_gw_vkey_active`: keys minted by this process and not revoked by it (approximate across replicas). */
  readonly active: Gauge;
  /** `bw_gw_vkey_mint_total{outcome}`. */
  readonly mints: Counter<'outcome'>;
  /** `bw_gw_vkey_revoke_total{trigger}`: keys revoked, by `ids` or `run`. */
  readonly revokes: Counter<'trigger'>;
  /** `bw_gw_auth_failures_total{reason}`: source refusals and rejected keys (coarse reasons only). */
  readonly authFailures: Counter<'reason'>;
}

export function createVirtualKeyMetrics(registry: Registry = new Registry()): VirtualKeyMetrics {
  return {
    registry,
    active: new Gauge({
      name: 'bw_gw_vkey_active',
      help: 'Virtual model keys minted by this process and not yet revoked.',
      registers: [registry],
    }),
    mints: new Counter({
      name: 'bw_gw_vkey_mint_total',
      help: 'Virtual model key mint requests by outcome.',
      labelNames: ['outcome'],
      registers: [registry],
    }),
    revokes: new Counter({
      name: 'bw_gw_vkey_revoke_total',
      help: 'Virtual model keys revoked, by trigger (explicit ids or a whole run).',
      labelNames: ['trigger'],
      registers: [registry],
    }),
    authFailures: new Counter({
      name: 'bw_gw_auth_failures_total',
      help: 'Internal virtual-key requests refused for source, identity or key reasons.',
      labelNames: ['reason'],
      registers: [registry],
    }),
  };
}
