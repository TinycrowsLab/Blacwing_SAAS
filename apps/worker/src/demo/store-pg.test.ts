import { describe, expect, it, vi } from 'vitest';

import { pgHuntStore } from './store-pg.js';

import type pg from 'pg';

const event = { kind: 'run.killed', stage: 'control', message: 'Run killed.', data: {} };

describe('pgHuntStore.appendEvent', () => {
  it('retries when the API took the same seq, so the worker event is not dropped', async () => {
    const query = vi.fn().mockRejectedValueOnce({ code: '23505' }).mockResolvedValueOnce({ rows: [] });
    await expect(pgHuntStore({ query } as unknown as pg.Pool).appendEvent('run-1', event)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain('max(seq)');
  });

  it('rethrows any other error at once', async () => {
    const query = vi.fn().mockRejectedValue({ code: '08006' });
    await expect(pgHuntStore({ query } as unknown as pg.Pool).appendEvent('run-1', event)).rejects.toEqual({ code: '08006' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('pgHuntStore.claimQueuedRun release mode', () => {
  const claimed = (request: Record<string, unknown>) => ({
    rows: [
      {
        id: 'run-1',
        tenant_id: 't',
        request_id: 'q',
        test_accounts: [],
        pins: {
          asset: { id: 'a', name: 'A', allowedOrigins: ['https://t.example'], excludedPaths: [] },
          request: { id: 'q', objective: 'o', budget: { requests: 10, seconds: 60, costUsd: 1 }, ...request },
        },
      },
    ],
  });

  it('reads hold from the pins, and defaults runs pinned before release modes to auto', async () => {
    const hold = vi.fn().mockResolvedValue(claimed({ releaseProven: 'hold' }));
    expect((await pgHuntStore({ query: hold } as unknown as pg.Pool).claimQueuedRun())?.releaseProven).toBe('hold');
    const old = vi.fn().mockResolvedValue(claimed({}));
    expect((await pgHuntStore({ query: old } as unknown as pg.Pool).claimQueuedRun())?.releaseProven).toBe('auto');
  });
});
