// POC-ONLY / offline-stub (#883): the dev subscription provider exists only for building Blackwing on the
// owner's host. OFFLINE-STUB(online-porting #884): replaced by the production provider (Anthropic API key /
// Bedrock); it must never power customer runs (CONTEXT_PACK §4.5).
import { AppError } from '@blackwing/errors';

import type { BwEnvironment, ProviderId } from '../config.js';

export const DEV_SUBSCRIPTION_PROVIDER_ID = 'dev_subscription' satisfies ProviderId;

/** Printed at boot and repeated as a WARN log line while the provider is active. */
export const DEV_SUBSCRIPTION_BANNER =
  'DEV SUBSCRIPTION PROVIDER ACTIVE - INTERNAL POC ONLY - NOT FOR CUSTOMER RUNS';

/** The only environment the provider may run in. Code-level: no config value can widen it. */
const ALLOWED_ENVIRONMENT: BwEnvironment = 'dev';

/** The two inputs of the guard: where the process runs and the explicit opt-in flag. */
export interface DevSubscriptionEnvironment {
  readonly BW_ENV?: BwEnvironment | undefined;
  readonly GATEWAY_DEV_SUBSCRIPTION_ENABLED: boolean;
}

/** Thrown when the dev subscription provider is configured where it is not allowed. */
export class DevSubscriptionRefusedError extends AppError {
  constructor(message: string) {
    super('CONFIG_INVALID', message);
  }
}

/** Why the provider is refused, or `undefined` when it is allowed. Depends on nothing but code. */
export function devSubscriptionRefusal(env: DevSubscriptionEnvironment): string | undefined {
  if (env.BW_ENV !== ALLOWED_ENVIRONMENT) {
    return `The dev_subscription provider requires BW_ENV=dev (got ${env.BW_ENV ?? 'unset'}).`;
  }
  if (!env.GATEWAY_DEV_SUBSCRIPTION_ENABLED) {
    return 'The dev_subscription provider requires GATEWAY_DEV_SUBSCRIPTION_ENABLED=true.';
  }
  return undefined;
}

/** Throws {@link DevSubscriptionRefusedError} unless `BW_ENV=dev` and the explicit flag are both set. */
export function assertDevSubscriptionAllowed(env: DevSubscriptionEnvironment): void {
  const refusal = devSubscriptionRefusal(env);
  if (refusal !== undefined) throw new DevSubscriptionRefusedError(refusal);
}

/** True when the configuration asks for the provider at all (flag set, or selected as the default). */
export function devSubscriptionRequested(config: {
  readonly GATEWAY_DEFAULT_PROVIDER: ProviderId;
  readonly GATEWAY_DEV_SUBSCRIPTION_ENABLED: boolean;
}): boolean {
  return (
    config.GATEWAY_DEV_SUBSCRIPTION_ENABLED ||
    config.GATEWAY_DEFAULT_PROVIDER === DEV_SUBSCRIPTION_PROVIDER_ID
  );
}
