import { describe, expect, it, vi } from 'vitest';

import { isPlausibleToken, previewKillLink, triggerKillLink } from './soc-kill';

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const opts = (fetch: typeof globalThis.fetch) => ({ fetch, apiOrigin: 'http://api.test/' });

describe('previewKillLink', () => {
  it('returns the scope and label, forwarding the visitor address and not caching', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { scope: 'asset', label: 'Payments API' }));
    await expect(previewKillLink('a.b.c', '203.0.113.7', opts(fetch))).resolves.toEqual({
      kind: 'valid',
      scope: 'asset',
      label: 'Payments API',
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/soc/kill/a.b.c');
    expect(init.headers).toEqual({ 'x-forwarded-for': '203.0.113.7' });
    expect(init.cache).toBe('no-store');
  });

  it('maps 429 to limited and every other failure to the same invalid answer', async () => {
    const answer = (res: Response | Error) =>
      previewKillLink(
        'a.b.c',
        null,
        opts(
          vi
            .fn()
            .mockImplementation(() =>
              res instanceof Error ? Promise.reject(res) : Promise.resolve(res),
            ),
        ),
      );
    await expect(answer(json(429))).resolves.toEqual({ kind: 'limited' });
    await expect(answer(json(404))).resolves.toEqual({ kind: 'invalid' });
    await expect(answer(json(500))).resolves.toEqual({ kind: 'invalid' });
    await expect(answer(json(200, { surprise: 1 }))).resolves.toEqual({ kind: 'invalid' });
    await expect(answer(new Error('down'))).resolves.toEqual({ kind: 'invalid' });
  });

  it('never calls the API for an implausible token', async () => {
    const fetch = vi.fn();
    for (const token of ['', 'a/b', 'a b', '../x', 'x'.repeat(2000)]) {
      expect(isPlausibleToken(token)).toBe(false);
      await expect(previewKillLink(token, null, opts(fetch))).resolves.toEqual({ kind: 'invalid' });
      await expect(triggerKillLink(token, null, opts(fetch))).resolves.toBe('invalid');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('triggerKillLink', () => {
  it('posts the token as JSON and reports done only on 202', async () => {
    const fetch = vi.fn().mockResolvedValue(json(202, { killEventId: 'k' }));
    await expect(triggerKillLink('a.b.c', '198.51.100.1', opts(fetch))).resolves.toBe('done');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/soc/kill');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ token: 'a.b.c' }));
    expect(init.headers).toMatchObject({ 'x-forwarded-for': '198.51.100.1' });
  });

  it.each([
    [429, 'limited'],
    [404, 'invalid'],
    [200, 'invalid'],
    [500, 'invalid'],
  ] as const)('maps status %i to %s', async (status, expected) => {
    const fetch = vi.fn().mockResolvedValue(json(status));
    await expect(triggerKillLink('a.b.c', null, opts(fetch))).resolves.toBe(expected);
  });
});
