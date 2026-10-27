/**
 * Open run event streams per tenant on this instance (#65). A stream holds a connection and a Valkey
 * subscription, so one tenant cannot be allowed to open unbounded ones. The cap is per instance, which
 * bounds each instance's load; a shared cap across instances is the rate limiter's job, not this one's.
 */
export class TenantStreamLimiter {
  readonly #open = new Map<string, number>();
  readonly #max: number;

  constructor(maxPerTenant: number) {
    if (!Number.isInteger(maxPerTenant) || maxPerTenant < 1) {
      throw new RangeError('the per-tenant stream cap must be a positive integer');
    }
    this.#max = maxPerTenant;
  }

  /**
   * Takes one slot for `tenantId`. Returns the release function, or `undefined` when the tenant is at
   * its cap. Releasing twice is harmless, so a stream that closes twice never frees another's slot.
   */
  tryAcquire(tenantId: string): (() => void) | undefined {
    const current = this.#open.get(tenantId) ?? 0;
    if (current >= this.#max) return undefined;
    this.#open.set(tenantId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#open.get(tenantId) ?? 1) - 1;
      if (left > 0) this.#open.set(tenantId, left);
      else this.#open.delete(tenantId);
    };
  }

  /** Open streams of a tenant (observability and tests). */
  openCount(tenantId: string): number {
    return this.#open.get(tenantId) ?? 0;
  }
}
