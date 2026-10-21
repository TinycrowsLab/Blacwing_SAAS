import { describe, expect, it } from 'vitest';

import { createTemporalWorkflowControlClient } from './workflow-client.js';

class NotFound extends Error {
  override name = 'WorkflowNotFoundError';
}

describe('createTemporalWorkflowControlClient', () => {
  const live = new AbortController().signal;

  it('requests cancellation per workflow and maps not-found and errors per id', async () => {
    const cancelled: string[] = [];
    const client = createTemporalWorkflowControlClient({
      getHandle: (id) => ({
        cancel: () => {
          if (id === 'gone') return Promise.reject(new NotFound('nope'));
          if (id === 'boom') return Promise.reject(new Error('unavailable'));
          cancelled.push(id);
          return Promise.resolve();
        },
      }),
    });
    const acks = await client.cancel(
      { killEventId: 'k', workflowIds: ['run-1', 'gone', 'boom', 'run-2'] },
      live,
    );
    expect(acks).toEqual([
      { workflowId: 'run-1', outcome: 'cancelled' },
      { workflowId: 'gone', outcome: 'not_found' },
      { workflowId: 'boom', outcome: 'failed' },
      { workflowId: 'run-2', outcome: 'cancelled' },
    ]);
    expect(cancelled).toEqual(['run-1', 'run-2']);
  });

  it('reports failed without calling Temporal once the deadline signal has aborted', async () => {
    const aborted = AbortSignal.abort();
    let called = 0;
    const client = createTemporalWorkflowControlClient({
      getHandle: () => ({
        cancel: () => {
          called += 1;
          return Promise.resolve();
        },
      }),
    });
    const acks = await client.cancel({ killEventId: 'k', workflowIds: ['a'] }, aborted);
    expect(acks).toEqual([{ workflowId: 'a', outcome: 'failed' }]);
    expect(called).toBe(0);
  });
});
