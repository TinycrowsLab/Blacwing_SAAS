import { Counter, type Registry } from 'prom-client';

/** Organisation-settings metrics (ADMIN-001). Labels are the section and the outcome only: never a value. */
export interface TenantProfileMetrics {
  /** One save attempt by an authorised caller: `ok` for a committed or no-op save, `error` when it is refused or fails. */
  saved(result: 'ok' | 'error'): void;
}

/** `bw_settings_save_total{section="org",result}` on the app's registry. */
export function createTenantProfileMetrics(registry: Registry): TenantProfileMetrics {
  const counter = new Counter({
    name: 'bw_settings_save_total',
    help: 'Settings save attempts by section and result.',
    labelNames: ['section', 'result'],
    registers: [registry],
  });
  return {
    saved: (result) => {
      counter.inc({ section: 'org', result });
    },
  };
}
