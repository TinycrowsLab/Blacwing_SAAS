import {
  createCrossTenantGuard,
  type CrossTenantAuditEmitter,
  resolveTenantContext,
  runWithTenantContext,
  type TenantContextMetrics,
} from '@blackwing/db/tenant-context';
import { TenantContextMissingError } from '@blackwing/errors';

import type {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  Next,
} from '@temporalio/worker';

/**
 * Loads the tenant a run belongs to (`null` when the run is unknown). The production adapter reads it
 * through the system role; it is asked on every activity attempt, never cached in process memory, so a
 * worker that resumes after pod loss re-derives the tenant from the `runId` alone (TENANT-003).
 */
type RunTenantResolver = (runId: string) => Promise<string | null>;

export interface TenantActivityDeps {
  readonly resolveRunTenant: RunTenantResolver;
  readonly audit: CrossTenantAuditEmitter;
  readonly metrics?: TenantContextMetrics;
}

/** An activity of a run takes an object whose `runId` is its first argument. Anything else fails closed. */
function runIdOf(args: readonly unknown[]): string {
  const [first] = args;
  const runId =
    typeof first === 'object' && first !== null ? (first as { runId?: unknown }).runId : undefined;
  if (typeof runId !== 'string' || runId === '') {
    throw new TenantContextMissingError('activity input carries no runId');
  }
  return runId;
}

/**
 * Temporal activity interceptor: derives the tenant from the activity's `runId` and runs the activity
 * body inside the `AsyncLocalStorage` tenant context. An unknown run, or a `tenantId` argument that
 * disagrees with the run's tenant, is refused before the body runs (fail closed, §8.6).
 */
export function createTenantActivityInterceptors(
  deps: TenantActivityDeps,
): ActivityInterceptorsFactory {
  const guard = createCrossTenantGuard({
    audit: deps.audit,
    ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
  });
  return () => {
    const inbound: ActivityInboundCallsInterceptor = {
      async execute(
        input: ActivityExecuteInput,
        next: Next<ActivityInboundCallsInterceptor, 'execute'>,
      ) {
        const runId = runIdOf(input.args);
        const runTenantId = await deps.resolveRunTenant(runId);
        const context = resolveTenantContext(
          { actor: { type: 'run', id: runId }, runTenantId },
          deps.metrics,
        );
        return runWithTenantContext(context, async () => {
          const [first] = input.args;
          const claimed = (first as { tenantId?: unknown }).tenantId;
          if (claimed !== undefined) {
            await guard.assertSameTenant(typeof claimed === 'string' ? claimed : null, {
              surface: 'worker.activity',
              resource: `run:${runId}`,
            });
          }
          return next(input);
        });
      },
    };
    return { inbound };
  };
}
