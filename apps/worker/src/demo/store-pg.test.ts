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
