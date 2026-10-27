import { fileURLToPath } from 'node:url';

import { bundleWorkflowCode } from '@temporalio/worker';
import { ApplicationFailure, CancelledFailure, ContinueAsNew } from '@temporalio/workflow';
import { describe, expect, it, vi } from 'vitest';

import { createWorkflowAuditInterceptor } from './audit-workflow.js';

import type { WorkflowAuditEvent } from './audit-shared.js';

const identity = () => ({ workflowType: 'Wf', workflowId: 'wf-1', executionRunId: 'e1' });

function setup() {
  const emitted: WorkflowAuditEvent[] = [];
  const emit = vi.fn((event: WorkflowAuditEvent) => {
    emitted.push(event);
    return Promise.resolve();
  });
  const execute = createWorkflowAuditInterceptor(emit, identity).execute;
  if (execute === undefined) throw new Error('no execute');
  const run = (next: () => Promise<unknown>, args: unknown[] = [{ runId: 'run-1' }]) =>
    execute({ args, headers: {} }, next);
  return { emitted, run };
}

describe('workflow audit interceptor', () => {
  it('emits started then completed', async () => {
    const { run, emitted } = setup();
    await expect(run(() => Promise.resolve(42))).resolves.toBe(42);
    expect(emitted.map((e) => e.kind)).toEqual(['started', 'completed']);
    expect(emitted[0]).toMatchObject({ runId: 'run-1', workflowType: 'Wf', executionRunId: 'e1' });
  });

  it('emits failed with a code, never the message', async () => {
    const { run, emitted } = setup();
    const error = ApplicationFailure.nonRetryable('password=hunter2', 'BOOM');
    await expect(run(() => Promise.reject(error))).rejects.toBe(error);
    expect(emitted.map((e) => e.kind)).toEqual(['started', 'failed']);
    expect(emitted[1]?.errorCode).toBe('BOOM');
    expect(JSON.stringify(emitted)).not.toContain('hunter2');
  });

  it('emits cancelled for a cancellation', async () => {
    const { run, emitted } = setup();
    await expect(run(() => Promise.reject(new CancelledFailure('stop')))).rejects.toBeInstanceOf(
      CancelledFailure,
    );
    expect(emitted.map((e) => e.kind)).toEqual(['started', 'cancelled']);
  });

  it('emits continued_as_new', async () => {
    const { run, emitted } = setup();
    await expect(run(() => Promise.reject(new ContinueAsNew({})))).rejects.toBeInstanceOf(
      ContinueAsNew,
    );
    expect(emitted.map((e) => e.kind)).toEqual(['started', 'continued_as_new']);
  });

  it('refuses a workflow with no runId and emits nothing', async () => {
    const { run, emitted } = setup();
    const next = vi.fn(() => Promise.resolve());
    await expect(run(next, [{}])).rejects.toMatchObject({ type: 'TENANT_CONTEXT_MISSING' });
    expect(next).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('fails closed when the started event cannot be written', async () => {
    const execute = createWorkflowAuditInterceptor(
      () => Promise.reject(new Error('outbox down')),
      identity,
    ).execute;
    const next = vi.fn(() => Promise.resolve());
    await expect(execute?.({ args: [{ runId: 'r' }], headers: {} }, next as never)).rejects.toThrow(
      'outbox down',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('bundles for the deterministic sandbox', async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL('../workflows/index.ts', import.meta.url)),
      workflowInterceptorModules: [fileURLToPath(new URL('./audit-workflow.ts', import.meta.url))],
    });
    expect(code).toContain('auditWorkflowEvent');
  }, 60_000);
});
