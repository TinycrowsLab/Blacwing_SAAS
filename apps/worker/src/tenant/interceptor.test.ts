import { describe, expect, it, vi } from 'vitest';

import {
  type CrossTenantDeniedEvent,
  currentTenantId,
  getTenantContext,
} from '@blackwing/db/tenant-context';
import { CrossTenantAccessError, TenantContextMissingError } from '@blackwing/errors';

import { createTenantActivityInterceptors } from './interceptor.js';

const TENANT_A = '0198f0a0-0000-7000-8000-00000000000a';
const TENANT_B = '0198f0a0-0000-7000-8000-00000000000b';
const RUN_A = 'run-a';
const RUN_B = 'run-b';

function harness() {
  const events: CrossTenantDeniedEvent[] = [];
  const tenants: Record<string, string> = { [RUN_A]: TENANT_A, [RUN_B]: TENANT_B };
  const resolveRunTenant = vi.fn((runId: string) => Promise.resolve(tenants[runId] ?? null));
  const factory = createTenantActivityInterceptors({
    resolveRunTenant,
    audit: (event) => {
      events.push(event);
    },
  });
  const inbound = factory({} as never).inbound;
  if (inbound?.execute === undefined) throw new Error('no inbound interceptor');
  const execute = inbound.execute.bind(inbound);
  const run = (args: unknown[], body: () => Promise<unknown> = () => Promise.resolve('done')) =>
    execute({ args, headers: {} }, body);
  return { events, resolveRunTenant, run };
}

describe('worker tenant activity interceptor', () => {
  it('runs the activity body under the tenant of its run', async () => {
    const { run } = harness();
    let seen: ReturnType<typeof getTenantContext>;
    await run([{ runId: RUN_A }], () => {
      seen = getTenantContext();
      return Promise.resolve();
    });
    expect(seen).toEqual({ tenantId: TENANT_A, actor: { type: 'run', id: RUN_A } });
    expect(currentTenantId()).toBeUndefined();
  });

  it('re-derives the tenant on every attempt instead of caching it', async () => {
    const { run, resolveRunTenant } = harness();
    await run([{ runId: RUN_A }]);
    await run([{ runId: RUN_A }]);
    expect(resolveRunTenant).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent activities of different runs apart', async () => {
    const { run } = harness();
    const seen = await Promise.all(
      [RUN_A, RUN_B, RUN_A, RUN_B].map((runId) =>
        run([{ runId }], async () => {
          await new Promise((resolve) => setTimeout(resolve, runId === RUN_A ? 20 : 2));
          return currentTenantId();
        }),
      ),
    );
    expect(seen).toEqual([TENANT_A, TENANT_B, TENANT_A, TENANT_B]);
  });

  it.each([
    ['no arguments', []],
    ['a non-object argument', ['x']],
    ['an empty runId', [{ runId: '' }]],
    ['an unknown run', [{ runId: 'run-unknown' }]],
  ])('fails closed on %s and never runs the body', async (_n, args) => {
    const { run } = harness();
    const body = vi.fn(() => Promise.resolve());
    await expect(run(args, body)).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(body).not.toHaveBeenCalled();
  });

  it('denies and audits a tenantId argument that is not the run tenant', async () => {
    const { run, events } = harness();
    const body = vi.fn(() => Promise.resolve());
    await expect(run([{ runId: RUN_A, tenantId: TENANT_B }], body)).rejects.toBeInstanceOf(
      CrossTenantAccessError,
    );
    expect(body).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'tenant.cross_tenant_denied',
      contextTenantId: TENANT_A,
      resourceTenantId: TENANT_B,
      surface: 'worker.activity',
    });
  });

  it('accepts a tenantId argument equal to the run tenant', async () => {
    const { run } = harness();
    await expect(run([{ runId: RUN_A, tenantId: TENANT_A }])).resolves.toBe('done');
  });
});
