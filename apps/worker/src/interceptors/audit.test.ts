import { describe, expect, it, vi } from 'vitest';

import { runWithTenantContext } from '@blackwing/db/tenant-context';
import { TenantContextMissingError } from '@blackwing/errors';

import { auditErrorCode, WORKFLOW_AUDIT_ACTIVITY } from './audit-shared.js';
import {
  createAuditActivities,
  createAuditActivityInterceptors,
  isCriticalActivity,
} from './audit.js';

import type { AuditEventInput } from '@blackwing/audit';

const TENANT = '0198f0a0-0000-7000-8000-00000000000a';
const RUN = '0198f0a0-0000-7000-8000-0000000000aa';

function harness(options: { sample?: ReadonlyMap<string, number>; failEmit?: () => boolean } = {}) {
  const events: AuditEventInput[] = [];
  const counts = { emitted: [] as string[], failed: 0 };
  const emitter = {
    emitAudit: vi.fn((input: AuditEventInput) => {
      if (options.failEmit?.() === true) return Promise.reject(new Error('db down'));
      events.push(input);
      return Promise.resolve();
    }),
  };
  const deps = {
    emitter,
    ...(options.sample === undefined ? {} : { sample: options.sample }),
    metrics: { emitted: (s: string) => counts.emitted.push(s), failed: () => (counts.failed += 1) },
    log: { error: vi.fn() } as never,
  };
  const factory = createAuditActivityInterceptors(deps);
  const run = (
    activityType: string,
    body: () => Promise<unknown> = () => Promise.resolve('ok'),
    args: unknown[] = [{ runId: RUN, name: 'x', nested: { a: 1 }, list: [1] }],
    attempt = 1,
  ) => {
    const ctx = {
      info: {
        activityType,
        activityId: 'act-1',
        attempt,
        workflowType: 'Wf',
        workflowExecution: { workflowId: 'wf-1', runId: 'r1' },
      },
    } as never;
    const execute = factory(ctx).inbound?.execute;
    if (execute === undefined) throw new Error('no interceptor');
    return runWithTenantContext({ tenantId: TENANT, actor: { type: 'run', id: RUN } }, () =>
      execute({ args, headers: {} }, body),
    );
  };
  return { events, counts, emitter, run, deps };
}

describe('audit activity interceptor', () => {
  it('emits started and succeeded for the tenant of the run', async () => {
    const { run, events, counts } = harness();
    await expect(run('doWork')).resolves.toBe('ok');
    expect(events.map((e) => e.action)).toEqual(['activity.started', 'activity.succeeded']);
    expect(events[0]).toMatchObject({
      tenantId: TENANT,
      runId: RUN,
      actor: { type: 'system', id: 'worker' },
      target: { type: 'run', id: RUN },
      outcome: 'success',
      dedupeKey: `${RUN}:act-1:1:started`,
      metadata: {
        activityType: 'doWork',
        attempt: 1,
        input: { runId: RUN, name: 'x', nested: '[object]', list: '[array]' },
      },
    });
    expect(counts.emitted).toEqual(['activity', 'activity']);
  });

  it('uses a different idempotency key per attempt, the same key on redelivery of one attempt', async () => {
    const { run, events } = harness();
    await run('doWork', undefined, undefined, 1);
    await run('doWork', undefined, undefined, 2);
    expect(new Set(events.map((e) => e.dedupeKey)).size).toBe(4);
    await run('doWork', undefined, undefined, 1);
    expect(events[4]?.dedupeKey).toBe(events[0]?.dedupeKey);
  });

  it('emits failed with the error code and no message or stack, then rethrows', async () => {
    const { run, events } = harness();
    const error = Object.assign(new Error('token=bwk_supersecretvalue1234567890'), {
      code: 'UPSTREAM_DOWN',
    });
    await expect(run('doWork', () => Promise.reject(error))).rejects.toBe(error);
    expect(events.map((e) => e.action)).toEqual(['activity.started', 'activity.failed']);
    const failed = events[1];
    expect(failed).toMatchObject({ outcome: 'failure', metadata: { errorCode: 'UPSTREAM_DOWN' } });
    expect(JSON.stringify(failed)).not.toMatch(/bwk_|stack|supersecret/);
  });

  it('records a cancelled activity as failed with reason cancelled', async () => {
    const { run, events } = harness();
    const cancel = Object.assign(new Error('cancelled'), { name: 'CancelledFailure' });
    await expect(run('doWork', () => Promise.reject(cancel))).rejects.toBe(cancel);
    expect(events[1]).toMatchObject({
      action: 'activity.failed',
      reason: 'cancelled',
      metadata: { errorCode: 'CANCELLED' },
    });
  });

  it('rejects without a tenant context or a runId, and never runs the body', async () => {
    const { deps } = harness();
    const body = vi.fn(() => Promise.resolve());
    const ctx = { info: { activityType: 'a', activityId: 'i', attempt: 1, workflowExecution: {} } };
    const execute = createAuditActivityInterceptors(deps)(ctx as never).inbound?.execute;
    await expect(execute?.({ args: [{ runId: RUN }], headers: {} }, body)).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    const h = harness();
    await expect(h.run('a', body, [{}])).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(body).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  it('does not audit the workflow-audit activity itself', async () => {
    const { run, events } = harness();
    await run(WORKFLOW_AUDIT_ACTIVITY);
    expect(events).toHaveLength(0);
  });

  describe('sampling', () => {
    const sample = new Map([
      ['noisy', 0.0001],
      ['gateDecision', 0.0001],
      ['killStage', 0.0001],
      ['applyStateChange', 0.0001],
    ]);

    it('samples a listed non-critical type, keeping failures', async () => {
      const { run, events } = harness({ sample });
      await run('noisy');
      expect(events).toHaveLength(0);
      await expect(run('noisy', () => Promise.reject(new Error('x')))).rejects.toThrow();
      expect(events.map((e) => e.action)).toEqual(['activity.failed']);
    });

    it('audits unlisted types in full', async () => {
      const { run, events } = harness({ sample });
      await run('other');
      expect(events).toHaveLength(2);
    });

    it.each(['gateDecision', 'killStage', 'applyStateChange'])(
      'never samples out the always-audit type %s',
      async (type) => {
        const { run, events } = harness({ sample });
        for (let attempt = 1; attempt <= 20; attempt += 1) {
          await run(type, undefined, undefined, attempt);
        }
        expect(events).toHaveLength(40);
        expect(isCriticalActivity(type)).toBe(true);
      },
    );
  });

  describe('when the audit write fails', () => {
    it('fails closed for a critical activity before running it', async () => {
      const { run, counts } = harness({ failEmit: () => true });
      const body = vi.fn(() => Promise.resolve('ok'));
      await expect(run('killStage', body)).rejects.toThrow('db down');
      expect(body).not.toHaveBeenCalled();
      expect(counts.failed).toBe(1);
    });

    it('lets a non-critical activity succeed, counts the failure and retries the queued events', async () => {
      let down = true;
      const { run, events, counts } = harness({ failEmit: () => down });
      await expect(run('doWork')).resolves.toBe('ok');
      expect(events).toHaveLength(0);
      expect(counts.failed).toBe(3); // started, then the retried started and succeeded
      down = false;
      await run('doWork', undefined, undefined, 2);
      expect(events.map((e) => e.dedupeKey)).toEqual([
        `${RUN}:act-1:1:started`,
        `${RUN}:act-1:1:succeeded`,
        `${RUN}:act-1:2:started`,
        `${RUN}:act-1:2:succeeded`,
      ]);
    });
  });
});

describe('workflow audit activity', () => {
  it('writes an idempotent outbox intent per workflow event', async () => {
    const { deps, events } = harness();
    const { auditWorkflowEvent } = createAuditActivities(deps);
    const input = {
      runId: RUN,
      kind: 'failed' as const,
      workflowType: 'Wf',
      workflowId: 'wf-1',
      executionRunId: 'exec-1',
      errorCode: 'BOOM',
    };
    await runWithTenantContext({ tenantId: TENANT, actor: { type: 'run', id: RUN } }, () =>
      auditWorkflowEvent(input),
    );
    expect(events[0]).toMatchObject({
      tenantId: TENANT,
      action: 'workflow.failed',
      outcome: 'failure',
      dedupeKey: `wf:${RUN}:wf-1:exec-1:failed`,
      metadata: { workflowType: 'Wf', errorCode: 'BOOM' },
    });
  });

  it('rejects without a tenant context and rethrows write failures', async () => {
    const { deps } = harness({ failEmit: () => true });
    const { auditWorkflowEvent } = createAuditActivities(deps);
    const input = {
      runId: RUN,
      kind: 'started' as const,
      workflowType: 'Wf',
      workflowId: 'w',
      executionRunId: 'e',
    };
    await expect(auditWorkflowEvent(input)).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(
      runWithTenantContext({ tenantId: TENANT, actor: { type: 'run', id: RUN } }, () =>
        auditWorkflowEvent(input),
      ),
    ).rejects.toThrow('db down');
  });
});

describe('auditErrorCode', () => {
  it('takes the innermost code or type and never the message', () => {
    const inner = Object.assign(new Error('secret'), { type: 'DEEP_TYPE' });
    const outer = Object.assign(new Error('wrapped'), { name: 'ActivityFailure', cause: inner });
    expect(auditErrorCode(outer)).toBe('DEEP_TYPE');
    expect(auditErrorCode(new TypeError('x'))).toBe('TypeError');
    expect(auditErrorCode('string')).toBe('UNKNOWN');
    expect(auditErrorCode(Object.assign(new Error('e'), { code: 'has spaces and secret' }))).toBe(
      'Error',
    );
  });
});
