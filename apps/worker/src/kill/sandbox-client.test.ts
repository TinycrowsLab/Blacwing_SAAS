import { describe, expect, it } from 'vitest';

import { createHttpSandboxControlClient, sandboxDeadlineFromEnv } from './sandbox-client.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const signal = (): AbortSignal => new AbortController().signal;

describe('createHttpSandboxControlClient', () => {
  it('posts a forced terminate and parses the acks', async () => {
    let seen: { url: string; body: unknown } | undefined;
    const client = createHttpSandboxControlClient({
      baseUrl: 'http://ctl.local',
      fetch: (url, init) => {
        seen = {
          url: typeof url === 'string' ? url : 'non-string',
          body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown,
        };
        return Promise.resolve(json({ acks: [{ sandboxId: 's1', outcome: 'terminated' }] }));
      },
    });
    const acks = await client.terminate({ killEventId: 'k', sandboxIds: ['s1'] }, signal());
    expect(acks).toEqual([{ sandboxId: 's1', outcome: 'terminated' }]);
    expect(seen?.url).toBe('http://ctl.local/sandboxes:terminate');
    expect(seen?.body).toMatchObject({ force: true, sandboxIds: ['s1'] });
  });

  it('throws on a non-200 or a malformed body', async () => {
    const bad = createHttpSandboxControlClient({
      baseUrl: 'http://x',
      fetch: () => Promise.resolve(json({}, 503)),
    });
    await expect(bad.terminate({ killEventId: 'k', sandboxIds: [] }, signal())).rejects.toThrow(
      /503/,
    );
    const odd = createHttpSandboxControlClient({
      baseUrl: 'http://x',
      fetch: () => Promise.resolve(json({ nope: 1 })),
    });
    await expect(odd.terminate({ killEventId: 'k', sandboxIds: [] }, signal())).rejects.toThrow();
  });
});

describe('sandboxDeadlineFromEnv', () => {
  it('uses a positive integer and falls back otherwise', () => {
    expect(sandboxDeadlineFromEnv('2500', 10_000)).toBe(2500);
    expect(sandboxDeadlineFromEnv(undefined, 10_000)).toBe(10_000);
    expect(sandboxDeadlineFromEnv('-1', 10_000)).toBe(10_000);
    expect(sandboxDeadlineFromEnv('abc', 10_000)).toBe(10_000);
  });
});
