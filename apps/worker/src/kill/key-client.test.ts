import { describe, expect, it, vi } from 'vitest';

import { createHttpKeyControlClient, KEYS_REVOKE_PATH } from './key-client.js';
import { KILL_ID } from './testing.js';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HTTP key control client', () => {
  it('POSTs /internal/keys:revoke with opaque key ids and parses the acks', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        json(200, {
          acks: [
            { keyId: 'k1', outcome: 'revoked' },
            { keyId: 'k2', outcome: 'already_revoked' },
          ],
        }),
      ),
    );
    const client = createHttpKeyControlClient({
      baseUrl: 'http://gw.local:4000',
      fetch: fetchMock,
    });
    const acks = await client.revoke(
      { killEventId: KILL_ID, keyIds: ['k1', 'k2'] },
      new AbortController().signal,
    );
    expect(acks).toEqual([
      { keyId: 'k1', outcome: 'revoked' },
      { keyId: 'k2', outcome: 'already_revoked' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`http://gw.local:4000${KEYS_REVOKE_PATH}`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ killEventId: KILL_ID, keyIds: ['k1', 'k2'] }));
    expect(new Headers(init?.headers).get('idempotency-key')).toBe(KILL_ID);
  });

  it('throws on a non-200 answer, an unknown outcome and a malformed body', async () => {
    const call = (response: Response) =>
      createHttpKeyControlClient({
        baseUrl: 'http://gw.local:4000',
        fetch: () => Promise.resolve(response),
      }).revoke({ killEventId: KILL_ID, keyIds: ['k1'] }, new AbortController().signal);
    await expect(call(json(503, {}))).rejects.toThrow(/HTTP 503/);
    await expect(call(json(200, { acks: [{ keyId: 'k1', outcome: 'maybe' }] }))).rejects.toThrow();
    await expect(call(json(200, { nope: true }))).rejects.toThrow();
  });
});
