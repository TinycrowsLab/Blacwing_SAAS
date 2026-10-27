import { describe, expect, it, vi } from 'vitest';

import { runDetailSchema } from './run-detail';
import { loadRun } from './run-detail.server';

const run = {
  publicId: 'run_01JABC7Q3M',
  state: 'executing',
  pauseReason: null,
  stateVersion: 3,
  mode: 'grey',
  trigger: 'console',
  requestedBy: 'Ada',
  assets: [{ id: 'a1', name: 'app.acme.test' }],
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  updatedAt: '2026-01-01T00:01:00.000Z',
};

function deps(response: Response | Error, cookie: string | undefined = 'c1') {
  const fetchMock = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  return {
    fetchMock,
    value: {
      readCookie: () => Promise.resolve(cookie),
      fetch: fetchMock as unknown as typeof fetch,
      bffOrigin: 'http://bff.test',
    },
  };
}

describe('loadRun', () => {
  it('returns the parsed run and forwards only the session cookie', async () => {
    const d = deps(Response.json(run));
    expect(await loadRun('run_01JABC7Q3M', d.value)).toEqual(run);
    const [url, init] = d.fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('http://bff.test/v1/runs/run_01JABC7Q3M');
    expect(init.headers).toEqual({ cookie: '__Host-bw_session=c1', accept: 'application/json' });
  });

  it('fails closed for unknown, foreign, forbidden and unauthenticated (404/403/401)', async () => {
    for (const status of [404, 403, 401]) {
      expect(
        await loadRun('run_01JABC7Q3M', deps(new Response('{}', { status })).value),
      ).toBeNull();
    }
  });

  it('never calls upstream for a malformed id or without a session', async () => {
    const d = deps(Response.json(run));
    for (const id of ['../admin', 'run_', '01JABC7Q3M', 'run_a/b', 'run_%2e']) {
      expect(await loadRun(id, d.value)).toBeNull();
    }
    expect(await loadRun('run_01JABC7Q3M', deps(Response.json(run), '').value)).toBeNull();
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it('throws on an outage or a body that breaks the contract', async () => {
    await expect(
      loadRun('run_01JABC7Q3M', deps(new Response('x', { status: 503 })).value),
    ).rejects.toThrow('503');
    await expect(
      loadRun('run_01JABC7Q3M', deps(Response.json({ ...run, state: 'bogus' })).value),
    ).rejects.toThrow();
    await expect(loadRun('run_01JABC7Q3M', deps(new Error('net')).value)).rejects.toThrow('net');
  });

  it('schema rejects unknown fields (no secrets can ride along)', () => {
    expect(runDetailSchema.safeParse({ ...run, runManifest: {} }).success).toBe(false);
  });
});
