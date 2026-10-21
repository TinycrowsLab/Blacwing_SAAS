import { describe, expect, it, vi } from 'vitest';

import { createHttpEgressControlClient, EGRESS_KILL_PATH } from './egress-client.js';
import { KILL_ID, RUN_ID, runIdentity } from './testing.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HTTP egress control client', () => {
  it('POSTs /control/kill with opaque ids and parses the acks', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(json(200, { acks: [{ identity: runIdentity(RUN_ID), outcome: 'blocked' }] })),
    );
    const client = createHttpEgressControlClient({
      baseUrl: 'http://localhost:13129',
      fetch: fetchMock,
    });
    const acks = await client.block(
      { killEventId: KILL_ID, identities: [runIdentity(RUN_ID)] },
      new AbortController().signal,
    );
    expect(acks).toEqual([{ identity: runIdentity(RUN_ID), outcome: 'blocked' }]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`http://localhost:13129${EGRESS_KILL_PATH}`);
    expect(init?.method).toBe('POST');
  });

  it('throws on a non-200 answer and on a malformed body', async () => {
    const bad = (response: Response) =>
      createHttpEgressControlClient({
        baseUrl: 'http://localhost:13129',
        fetch: () => Promise.resolve(response),
      }).block({ killEventId: KILL_ID, identities: [] }, new AbortController().signal);
    await expect(bad(json(503, {}))).rejects.toThrow(/HTTP 503/);
    await expect(bad(json(200, { nope: true }))).rejects.toThrow();
  });
});
