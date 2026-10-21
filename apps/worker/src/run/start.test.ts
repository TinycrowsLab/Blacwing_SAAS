import { describe, expect, it } from 'vitest';

import { runWorkflowId } from '@blackwing/contracts';

import { TASK_QUEUES } from '../task-queues.js';
import { assessmentRunStartOptions } from './start.js';
import { runInput } from './testing.js';

describe('assessmentRunStartOptions', () => {
  it('uses run_<id>, the run-orchestration queue and per-tenant search attributes', () => {
    const input = runInput();
    const opts = assessmentRunStartOptions(input);
    expect(opts.workflowId).toBe(runWorkflowId(input.runId));
    expect(opts.taskQueue).toBe(TASK_QUEUES.RUN_ORCHESTRATION);
    expect(opts.searchAttributes.tenantId).toEqual([input.tenantId]);
    expect(opts.workflowIdReusePolicy).toBe('REJECT_DUPLICATE');
    expect(opts.args).toEqual([input]);
  });

  it('rejects an invalid or oversized input before anything starts', () => {
    expect(() =>
      assessmentRunStartOptions({ ...runInput(), objective: 'x'.repeat(4001) }),
    ).toThrow();
    expect(() => assessmentRunStartOptions({ ...runInput(), assetIds: [] })).toThrow();
    expect(() => assessmentRunStartOptions({ ...runInput(), extra: true })).toThrow();
  });
});
