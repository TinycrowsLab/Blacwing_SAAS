import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventLog, newHuntState, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { attachProofScreenshots, captureShots, renderableHtml, resolveBrowser, type BrowserLike, type ContextLike, type Launcher, type RouteLike, type ShotJob, type ShotSide } from './screenshot.js';

import type { HuntRun } from './types.js';
import type { Verdict } from './validator.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const ORIGIN = 'https://t.example';

interface Log {
  gotos: string[];
  contents: string[];
  cookies: { name: string; value: string; url: string }[];
  routed: { url: string; action: string; headers?: Record<string, string> | undefined }[];
  contextOptions: Record<string, unknown>[];
  closed: number;
}

/** A browser double: `goto` asks the route handler for each URL, then reports what happened. */
function mockBrowser(extraRequests: string[] = []): { launch: Launcher; log: Log } {
  const log: Log = { gotos: [], contents: [], cookies: [], routed: [], contextOptions: [], closed: 0 };
  const browser: BrowserLike = {
    newContext(options) {
      log.contextOptions.push(options);
      let handler: ((route: RouteLike) => Promise<void>) | null = null;
      const ask = async (url: string): Promise<void> => {
        await handler?.({
          request: () => ({ url: () => url, headers: () => ({ accept: '*/*' }) }),
          abort: (code) => {
            log.routed.push({ url, action: `abort:${code ?? ''}` });
            return Promise.resolve();
          },
          continue: (o) => {
            log.routed.push({ url, action: 'continue', headers: o?.headers });
            return Promise.resolve();
          },
        });
      };
      const context: ContextLike = {
        newPage: () =>
          Promise.resolve({
            goto: async (url: string) => {
              if (url === 'about:blank') return null;
              log.gotos.push(url);
              await ask(url);
              for (const extra of extraRequests) await ask(extra);
              return { status: () => 200 };
            },
            setContent: (html: string) => {
              log.contents.push(html);
              return Promise.resolve();
            },
            screenshot: () => Promise.resolve(PNG),
          }),
        addCookies: (c) => {
          log.cookies.push(...c);
          return Promise.resolve();
        },
        route: (_pattern, h) => {
          handler = h;
          return Promise.resolve();
        },
        close: () => {
          log.closed += 1;
          return Promise.resolve();
        },
      };
      return Promise.resolve(context);
    },
    close: () => Promise.resolve(),
  };
  return { launch: () => Promise.resolve(browser), log };
}

const shell = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'bw-shot-'));
  const exe = join(home, '.cache', 'ms-playwright', 'chromium_headless_shell-9', 'chrome-headless-shell-linux64');
  mkdirSync(exe, { recursive: true });
  writeFileSync(join(exe, 'chrome-headless-shell'), '');
  return home;
};

const side = (over: Partial<ShotSide> = {}): ShotSide => ({
  kind: 'probe',
  method: 'GET',
  url: `${ORIGIN}/a?id=1%27`,
  headers: { authorization: 'Bearer SECRET' },
  cookies: { sid: 'abc' },
  response: { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><head></head><body>boom</body></html>' },
  navigate: true,
  ...over,
});

const job = (sides: ShotSide[], budget = 100): ShotJob & { used: number } => {
  const j = { used: 0, sides, allow: (u: string) => u.startsWith(ORIGIN), remaining: () => budget - j.used, take: () => (j.used >= budget ? false : ((j.used += 1), true)) };
  return j;
};

describe('resolveBrowser', () => {
  it('prefers the env path, then the newest install, else null', () => {
    const home = shell();
    expect(resolveBrowser({}, home)).toContain('chrome-headless-shell');
    expect(resolveBrowser({ BW_SCREENSHOT_BROWSER: '/nope/chrome' }, home)).toBeNull();
    expect(resolveBrowser({}, mkdtempSync(join(tmpdir(), 'bw-empty-')))).toBeNull();
  });
});

describe('captureShots', () => {
  it('skips gracefully when no browser exists, or screenshots are off', async () => {
    const none = await captureShots(job([side()]), { env: { HOME: '/nonexistent', BW_SCREENSHOT_BROWSER: '/nope' } });
    expect(none.status).toBe('skipped');
    expect(none.note).toMatch(/no Chromium/);
    expect((await captureShots(job([side()]), { env: { BW_SCREENSHOTS: 'off' } })).status).toBe('skipped');
  });

  it('navigates a GET with the role cookies and headers, counts it, and blocks other origins', async () => {
    const { launch, log } = mockBrowser(['https://evil.example/x.js', `${ORIGIN}/style.css`]);
    const j = job([side()]);
    const exe = join(shell(), '.cache', 'ms-playwright');
    const result = await captureShots(j, { env: { PLAYWRIGHT_BROWSERS_PATH: exe }, launch });
    expect(result.status).toBe('captured');
    expect(result.shots[0]?.mode).toBe('navigated');
    expect(log.gotos).toEqual([`${ORIGIN}/a?id=1%27`]);
    expect(log.cookies).toEqual([{ name: 'sid', value: 'abc', url: ORIGIN }]);
    expect(log.contextOptions[0]).toMatchObject({ javaScriptEnabled: false });
    expect(log.routed.find((r) => r.url.includes('evil'))?.action).toMatch(/^abort/);
    expect(log.routed.filter((r) => r.action === 'continue')).toHaveLength(2);
    expect(log.routed.find((r) => r.action === 'continue')?.headers?.authorization).toBe('Bearer SECRET');
    expect(j.used).toBe(2);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(log.closed).toBe(1);
  });

  it('renders a non-GET response with setContent and a base href, sending nothing', async () => {
    const { launch, log } = mockBrowser();
    const j = job([side({ method: 'POST', navigate: false, url: `${ORIGIN}/login`, response: { status: 500, headers: {}, body: 'SQL error <b>' } })]);
    const result = await captureShots(j, { env: { PLAYWRIGHT_BROWSERS_PATH: join(shell(), '.cache', 'ms-playwright') }, launch });
    expect(result.shots[0]?.mode).toBe('rendered');
    expect(log.gotos).toHaveLength(0);
    expect(log.contents[0]).toContain(`<base href="${ORIGIN}/login">`);
    expect(log.contents[0]).toContain('SQL error &lt;b&gt;');
    expect(j.used).toBe(0);
  });

  it('does not navigate once the request budget is used up', async () => {
    const { launch, log } = mockBrowser();
    const result = await captureShots(job([side()], 0), { env: { PLAYWRIGHT_BROWSERS_PATH: join(shell(), '.cache', 'ms-playwright') }, launch });
    expect(result.status).toBe('failed');
    expect(result.note).toMatch(/budget/);
    expect(log.gotos).toHaveLength(0);
  });

  it('reports a launch failure without throwing', async () => {
    const result = await captureShots(job([side()]), { env: { PLAYWRIGHT_BROWSERS_PATH: join(shell(), '.cache', 'ms-playwright') }, launch: () => Promise.reject(new Error('boom')) });
    expect(result.status).toBe('failed');
  });
});

describe('renderableHtml', () => {
  it('puts the base after <head>', () => {
    expect(renderableHtml(side())).toMatch(/<head><meta charset="utf-8"><base href=/);
  });
});

describe('attachProofScreenshots', () => {
  const run: HuntRun = {
    id: 'r', tenantId: 't', requestId: 'q', assetId: 'a', assetName: 'A', objective: 'o',
    scope: { allowedOrigins: [ORIGIN], excludedPaths: [] }, budgetRequests: 20, budgetSeconds: 60, costCapUsd: 1,
    intrusiveness: 'active_safe', testAccounts: [{ role: 'user', headerName: 'Authorization', headerValue: 'Bearer SECRET' }], releaseProven: 'hold', labOrigins: [],
  };
  const sent = (url: string, body: string) => ({ ok: true as const, exchangeId: 'e', status: 200, headers: { 'content-type': 'text/html' }, body, bodyBytes: body.length, request: { method: 'GET', url, headers: {}, body: null, asRole: 'user' } });

  it('stores the pair against the finding, using the role credential', async () => {
    const store = new FakeStore();
    const ctx: HuntContext = {
      run, store, log: new EventLog(store, 'r', { warn: () => undefined, error: () => undefined }), signal: new AbortController().signal,
      deps: { fetch: fetch, sleep: () => Promise.resolve(), now: () => 0, gate2TimeoutMs: 1, webhookUrl: null, consoleOrigin: 'http://c' },
      state: newHuntState(),
    };
    const candidate = { probe: { method: 'GET', url: `${ORIGIN}/a?id=1'`, as_role: 'user' }, control: { method: 'GET', url: `${ORIGIN}/a?id=1`, as_role: 'user' } };
    const verdict = { confirmed: true, reason: '', delta: 'query', replays: [], probe: sent(candidate.probe.url, 'err'), control: sent(candidate.control.url, 'ok'), controlMatched: false } as Verdict;
    const { launch, log } = mockBrowser();
    const result = await attachProofScreenshots(ctx, 'f1', candidate, verdict, { env: { PLAYWRIGHT_BROWSERS_PATH: join(shell(), '.cache', 'ms-playwright') }, launch });
    expect(result?.shots.map((s) => s.kind)).toEqual(['probe', 'control']);
    expect(store.screenshots[0]?.findingId).toBe('f1');
    expect(log.routed.find((r) => r.action === 'continue')?.headers?.authorization).toBe('Bearer SECRET');
    expect(ctx.state.requestsUsed).toBe(2);
    expect(store.events.some((e) => e.kind === 'screenshot.captured')).toBe(true);
    expect(await attachProofScreenshots(ctx, 'f1', candidate, { ...verdict, confirmed: false }, {})).toBeNull();
  });
});
