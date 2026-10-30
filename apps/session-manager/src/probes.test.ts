import { describe, expect, it } from 'vitest';

import { createOpenBaoProbe, createPostgresProbe, createValkeyProbe } from './probes.js';

/** A loopback port nothing listens on: connections are refused at once, so no test waits on a timeout. */
const CLOSED_PORT = 1;

function fakeFetch(status: number): typeof fetch {
  return (): Promise<Response> => Promise.resolve(new Response(null, { status }));
}

describe('OpenBao health probe', () => {
  it.each([200, 429, 472, 473])('treats a %s health answer as reachable', async (status) => {
    await expect(
      createOpenBaoProbe('http://openbao:8200', fakeFetch(status)).check(),
    ).resolves.toBeUndefined();
  });

  it.each([501, 503])('fails on a %s (uninitialised or sealed) answer', async (status) => {
    await expect(
      createOpenBaoProbe('http://openbao:8200', fakeFetch(status)).check(),
    ).rejects.toThrow(/openbao health answered/);
  });

  it('fails when OpenBao cannot be reached', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(createOpenBaoProbe('http://openbao:8200', down).check()).rejects.toThrow();
  });

  it('calls the health endpoint on the configured address and never follows redirects', async () => {
    const calls: { url: string; redirect: string | undefined }[] = [];
    const recording = ((input: unknown, init?: { redirect?: string }): Promise<Response> => {
      calls.push({ url: String(input), redirect: init?.redirect });
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;
    await createOpenBaoProbe('https://bao.internal:8200/', recording).check();
    expect(calls).toEqual([{ url: 'https://bao.internal:8200/v1/sys/health', redirect: 'error' }]);
  });
});

describe('PostgreSQL and Valkey probes fail on an unreachable dependency', () => {
  it('postgres probe rejects when the server refuses the connection', async () => {
    const probe = createPostgresProbe(`postgres://sm:pw@127.0.0.1:${String(CLOSED_PORT)}/bw`);
    await expect(probe.check()).rejects.toThrow();
    await expect(probe.close()).resolves.toBeUndefined();
  });

  it('valkey probe rejects and closes cleanly when the server refuses the connection', async () => {
    const probe = createValkeyProbe(`redis://127.0.0.1:${String(CLOSED_PORT)}/0`);
    await expect(probe.check()).rejects.toThrow();
    await expect(probe.close()).resolves.toBeUndefined();
  });
});
