import { AppError, type AppErrorOptions } from '@blackwing/errors';

/**
 * Plan quota refusals (TENANT-009). Both answer RFC 9457 problem+json through the registry. The detail names
 * the resource, the limit and the current usage: counts and USD only, never a tenant name or a target.
 */

/** `QUOTA_EXCEEDED` (409): a count limit of the tenant's plan would be passed by this creation. */
export class QuotaExceededError extends AppError {
  declare readonly code: 'QUOTA_EXCEEDED';
  constructor(
    readonly resource: string,
    readonly limit: number,
    readonly used: number,
    options: AppErrorOptions = {},
  ) {
    super('QUOTA_EXCEEDED', 'plan quota exceeded', {
      detail: `The plan allows ${String(limit)} ${resource}; this tenant has ${String(used)}. Free a slot or change the plan.`,
      ...options,
    });
  }
}

/** `COST_CAP_EXCEEDED` (402): the monthly cost cap is reached, so no new spend may start this UTC month. */
export class CostCapExceededError extends AppError {
  declare readonly code: 'COST_CAP_EXCEEDED';
  constructor(
    readonly limitUsd: number,
    readonly usedUsd: number,
    options: AppErrorOptions = {},
  ) {
    super('COST_CAP_EXCEEDED', 'monthly cost cap exceeded', {
      detail: `The monthly cost cap of ${limitUsd.toFixed(2)} USD is reached (${usedUsd.toFixed(2)} USD used this month, UTC).`,
      ...options,
    });
  }
}
