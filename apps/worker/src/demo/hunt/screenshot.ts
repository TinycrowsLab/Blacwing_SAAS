// PoC screenshots of a proven finding: the probe and its negative control, rendered by a headless browser so a person
// sees what the validator saw. A GET is navigated to with the role's cookies and headers (injected by the runner, never
// printed); any other method renders the recorded response with `setContent`, so nothing is sent twice. The browser is
// held to the scope guard (every request to another origin is aborted), every request it makes counts against the
// run's request budget, and JavaScript is off (the target's page is untrusted). Without a browser the capture is
// skipped and the evidence says so. Nothing here decides a verdict.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { scrub } from '@blackwing/errors/scrub';

import { checkScope, classifyMethod } from './scope.js';

import type { HuntContext } from './context.js';
import type { HttpRequest, HttpResult } from './http-tool.js';
import type { Candidate, Verdict } from './validator.js';

export const SHOT_WIDTH = 1280;
export const SHOT_HEIGHT = 800;
const MS_PER_S = 1000;
const NAV_TIMEOUT_S = 15;
const LAUNCH_TIMEOUT_S = 20;
const NAV_TIMEOUT_MS = NAV_TIMEOUT_S * MS_PER_S;
const LAUNCH_TIMEOUT_MS = LAUNCH_TIMEOUT_S * MS_PER_S;
const MAX_SUBREQUESTS = 40;
const BYTES_PER_KB = 1024;
const MAX_PNG_BYTES = 2 * BYTES_PER_KB * BYTES_PER_KB;
const MAX_NOTE_CHARS = 300;
const DROPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'cookie']);
const LOGOUT_PATH = /log-?out|sign-?out/i;
const USER_AGENT = 'blackwing-hunt/1 (screenshot)';

export type ShotKind = 'probe' | 'control';

export interface ProofShot {
  readonly kind: ShotKind;
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  /** `navigated`: the browser asked the target; `rendered`: the recorded response was drawn from memory. */
  readonly mode: 'navigated' | 'rendered';
  /** Scrubbed request URL. */
  readonly url: string;
  readonly method: string;
  readonly status: number | null;
}

export interface ShotResult {
  readonly status: 'captured' | 'partial' | 'skipped' | 'failed';
  /** One plain sentence for the evidence ("No browser is installed..."). */
  readonly note: string;
  readonly shots: readonly ProofShot[];
}

/** What one side needs: the request as the runner sent it (credentials included, never logged) and the response it got. */
export interface ShotSide {
  readonly kind: ShotKind;
  readonly method: string;
  readonly url: string;
  /** Request headers to send (credentials included); `cookie` is ignored, use `cookies`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly cookies: Readonly<Record<string, string>>;
  readonly response: { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string } | null;
  /** True when the URL may be navigated to (a GET that does not change state). */
  readonly navigate: boolean;
}

export interface ShotJob {
  readonly sides: readonly ShotSide[];
  /** The scope guard: false for any URL the browser must not reach. */
  readonly allow: (url: string) => boolean;
  /** Requests the run budget still allows. */
  readonly remaining: () => number;
  /** Counts one request against the budget; false when none is left. */
  readonly take: () => boolean;
}

/* Minimal views of the playwright-core API, so tests can mock the browser. */
export interface RouteLike {
  request(): { url(): string; headers(): Record<string, string> };
  abort(code?: string): Promise<void>;
  continue(options?: { headers?: Record<string, string> }): Promise<void>;
}
export interface PageLike {
  goto(url: string, options?: { waitUntil?: 'load'; timeout?: number }): Promise<{ status(): number } | null>;
  setContent(html: string, options?: { waitUntil?: 'load'; timeout?: number }): Promise<void>;
  screenshot(options: { type: 'png'; fullPage: false; timeout?: number }): Promise<Buffer>;
}
export interface ContextLike {
  newPage(): Promise<PageLike>;
  addCookies(cookies: { name: string; value: string; url: string }[]): Promise<void>;
  route(url: string, handler: (route: RouteLike) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserLike {
  newContext(options: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
}
export type Launcher = (executablePath: string, args: string[]) => Promise<BrowserLike>;

const defaultLauncher: Launcher = async (executablePath, args) => {
  const { chromium } = await import('playwright-core');
  return (await chromium.launch({ executablePath, args, headless: true, timeout: LAUNCH_TIMEOUT_MS })) as unknown as BrowserLike;
};

type Env = Readonly<Record<string, string | undefined>>;

const revisionOf = (name: string): number => Number(/-(\d+)$/.exec(name)?.[1] ?? 0);

/**
 * The Chromium to use: `BW_SCREENSHOT_BROWSER` when set, else the newest headless shell (then full Chromium) under
 * `PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`. Null when none is installed.
 */
export function resolveBrowser(env: Env = process.env, home: string = homedir()): string | null {
  const explicit = env.BW_SCREENSHOT_BROWSER?.trim();
  if (explicit !== undefined && explicit !== '') return existsSync(explicit) ? explicit : null;
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, join(home, '.cache', 'ms-playwright'), join(home, 'Library', 'Caches', 'ms-playwright')].filter(
    (r): r is string => r !== undefined && r !== '' && r !== '0',
  );
  const kinds: [RegExp, string[]][] = [
    [/^chromium_headless_shell-\d+$/, ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell']],
    [/^chromium-\d+$/, ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']],
  ];
  for (const [pattern, executables] of kinds) {
    for (const root of roots) {
      let names: string[];
      try {
        names = readdirSync(root).filter((n) => pattern.test(n)).sort((a, b) => revisionOf(b) - revisionOf(a));
      } catch {
        continue;
      }
      for (const name of names) {
        const found = executables.map((e) => join(root, name, e)).find((p) => existsSync(p));
        if (found !== undefined) return found;
      }
    }
  }
  return null;
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The recorded response as a page: HTML as is, anything else as preformatted text; `<base>` makes relative links resolve on the target. */
export function renderableHtml(side: ShotSide): string {
  const body = side.response?.body ?? '';
  const type = Object.entries(side.response?.headers ?? {}).find(([n]) => n.toLowerCase() === 'content-type')?.[1] ?? '';
  const isHtml = /html/i.test(type) || (type === '' && /^\s*(<!doctype|<html|<body|<head|<div|<p|<h\d)/i.test(body));
  const base = `<base href="${escapeHtml(side.url).replace(/"/g, '&quot;')}">`;
  if (!isHtml) return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body style="margin:12px"><pre style="white-space:pre-wrap;word-break:break-word;font:13px/1.4 ui-monospace,monospace">${escapeHtml(body)}</pre></body></html>`;
  const head = /<head[^>]*>/i.exec(body);
  if (head !== null) return `${body.slice(0, head.index + head[0].length)}<meta charset="utf-8">${base}${body.slice(head.index + head[0].length)}`;
  return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${body}</body></html>`;
}

const clip = (text: string): string => scrub(text).slice(0, MAX_NOTE_CHARS);

async function shootSide(context: ContextLike, side: ShotSide, job: ShotJob): Promise<ProofShot | { skipped: string }> {
  const navigating = side.navigate && side.method.toUpperCase() === 'GET';
  if (navigating && job.remaining() < 1) return { skipped: `the ${side.kind} was not captured: the request budget is used up` };
  if (navigating && LOGOUT_PATH.test(new URL(side.url).pathname)) return { skipped: `the ${side.kind} was not captured: it is a sign-out page` };
  if (!navigating && side.response === null) return { skipped: `the ${side.kind} was not captured: no response was recorded` };
  const page = await context.newPage();
  await page.goto('about:blank').catch(() => null);
  if (navigating) {
    const response = await page.goto(side.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    const png = await page.screenshot({ type: 'png', fullPage: false, timeout: NAV_TIMEOUT_MS });
    return finish(side, png, 'navigated', response?.status() ?? side.response?.status ?? null);
  }
  await page.setContent(renderableHtml(side), { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  const png = await page.screenshot({ type: 'png', fullPage: false, timeout: NAV_TIMEOUT_MS });
  return finish(side, png, 'rendered', side.response?.status ?? null);
}

function finish(side: ShotSide, png: Buffer, mode: 'navigated' | 'rendered', status: number | null): ProofShot | { skipped: string } {
  if (png.byteLength > MAX_PNG_BYTES) return { skipped: `the ${side.kind} screenshot was too large to keep` };
  return { kind: side.kind, png, width: SHOT_WIDTH, height: SHOT_HEIGHT, mode, url: scrub(side.url), method: side.method.toUpperCase(), status };
}

/** Captures every side of a job in one browser session. Never throws: any failure becomes a `skipped` or `failed` result. */
export async function captureShots(job: ShotJob, options: { env?: Env; launch?: Launcher } = {}): Promise<ShotResult> {
  const env = options.env ?? process.env;
  if ((env.BW_SCREENSHOTS ?? '').toLowerCase() === 'off') return { status: 'skipped', note: 'Screenshots are turned off (BW_SCREENSHOTS=off).', shots: [] };
  if (job.sides.length === 0) return { status: 'skipped', note: 'There was nothing to capture.', shots: [] };
  const executable = resolveBrowser(env);
  if (executable === null) {
    return { status: 'skipped', note: 'No screenshot was taken: no Chromium browser is installed on the runner (set BW_SCREENSHOT_BROWSER to its path).', shots: [] };
  }
  const args = env.BW_SCREENSHOT_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
  let browser: BrowserLike | null = null;
  const shots: ProofShot[] = [];
  const notes: string[] = [];
  try {
    browser = await (options.launch ?? defaultLauncher)(executable, args);
    for (const side of job.sides) {
      let context: ContextLike | null = null;
      try {
        const origin = new URL(side.url).origin;
        context = await browser.newContext({ viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT }, javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false, userAgent: USER_AGENT, deviceScaleFactor: 1 });
        let sub = 0;
        await context.route('**/*', async (route) => {
          const request = route.request();
          const url = request.url();
          // Only the target: anything else (another origin, data: and file: included, a redirect off site) is aborted.
          if (!/^https?:/i.test(url) || new URL(url).origin !== origin || !job.allow(url)) return route.abort('blockedbyclient');
          if (url === side.url ? false : (sub += 1) > MAX_SUBREQUESTS) return route.abort('blockedbyclient');
          if (!job.take()) return route.abort('blockedbyclient');
          return route.continue({ headers: { ...request.headers(), ...lowercased(side.headers) } });
        });
        const cookies = Object.entries(side.cookies).map(([name, value]) => ({ name, value, url: origin }));
        if (cookies.length > 0) await context.addCookies(cookies);
        const one = await shootSide(context, side, job);
        if ('skipped' in one) notes.push(one.skipped);
        else shots.push(one);
      } catch (error) {
        notes.push(`the ${side.kind} was not captured (${clip(error instanceof Error ? error.message.split('\n')[0] ?? error.name : 'error')})`);
      } finally {
        await context?.close().catch(() => undefined);
      }
    }
  } catch (error) {
    return { status: 'failed', note: `No screenshot was taken: the browser did not start (${clip(error instanceof Error ? error.message.split('\n')[0] ?? error.name : 'error')}).`, shots: [] };
  } finally {
    await browser?.close().catch(() => undefined);
  }
  const wanted = job.sides.length;
  if (shots.length === 0) return { status: 'failed', note: `No screenshot was taken: ${notes.join('; ') || 'nothing could be captured'}.`, shots };
  const how = shots.map((s) => `${s.kind} ${s.mode === 'navigated' ? 'loaded in the browser' : 'drawn from the recorded response'}`).join(', ');
  return shots.length === wanted
    ? { status: 'captured', note: `Screenshots taken by a headless browser (${how}; scripts off, only the target origin reachable).`, shots }
    : { status: 'partial', note: `Some screenshots were taken (${how}); ${notes.join('; ')}.`, shots };
}

function lowercased(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([n]) => !DROPPED_HEADERS.has(n.toLowerCase())).map(([n, v]) => [n.toLowerCase(), v]));
}

type Sent = Extract<HttpResult, { ok: true }>;

function sideFor(ctx: HuntContext, kind: ShotKind, request: HttpRequest, sent: Sent): ShotSide {
  const account = request.as_role === undefined ? undefined : ctx.run.testAccounts.find((a) => a.role.toLowerCase() === request.as_role?.toLowerCase());
  const jar = account?.login === undefined ? undefined : ctx.state.sessions.get(account.role.toLowerCase())?.jar;
  const cookies: Record<string, string> = Object.fromEntries(jar ?? []);
  const own = Object.entries(request.headers ?? {}).find(([n]) => n.toLowerCase() === 'cookie')?.[1] ?? '';
  for (const part of own.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const headers: Record<string, string> = { ...request.headers };
  if (account !== undefined && account.login === undefined) headers[account.headerName] = account.headerValue;
  let navigate = false;
  try {
    navigate = request.method.toUpperCase() === 'GET' && classifyMethod('GET', new URL(request.url)) === 'active_safe';
  } catch {
    navigate = false;
  }
  return { kind, method: request.method, url: request.url, headers, cookies, response: { status: sent.status, headers: sent.headers, body: sent.body }, navigate };
}

/** The sides of a confirmed verdict (probe, then control when there is one); empty for anything not proven. */
export function sidesOf(ctx: HuntContext, candidate: Pick<Candidate, 'probe' | 'control'>, verdict: Verdict): ShotSide[] {
  if (!verdict.confirmed || verdict.probe === null) return [];
  const sides = [sideFor(ctx, 'probe', candidate.probe, verdict.probe)];
  if (candidate.control !== undefined && verdict.control !== null) sides.push(sideFor(ctx, 'control', candidate.control, verdict.control));
  return sides;
}

/**
 * Called once after a finding is stored: captures the probe/control screenshots, stores them with the finding and says
 * what happened in the run log. Best effort: a failure here never touches the finding or the run.
 */
export async function attachProofScreenshots(
  ctx: HuntContext,
  findingId: string,
  candidate: Pick<Candidate, 'probe' | 'control'>,
  verdict: Verdict,
  options: { env?: Env; launch?: Launcher } = {},
): Promise<ShotResult | null> {
  const sides = sidesOf(ctx, candidate, verdict);
  if (sides.length === 0) return null;
  let result: ShotResult;
  try {
    result = await captureShots(
      {
        sides,
        allow: (url) => checkScope(url, ctx.run.scope).ok,
        remaining: () => Math.max(0, ctx.run.budgetRequests - ctx.state.requestsUsed),
        take: () => {
          if (ctx.state.requestsUsed >= ctx.run.budgetRequests) return false;
          ctx.state.requestsUsed += 1;
          return true;
        },
      },
      options,
    );
  } catch {
    result = { status: 'failed', note: 'No screenshot was taken: the capture failed.', shots: [] };
  }
  try {
    await ctx.store.saveScreenshots(ctx.run, findingId, result);
    const kinds = result.shots.map((s) => s.kind);
    await ctx.log.emit(result.shots.length > 0 ? 'screenshot.captured' : 'screenshot.skipped', 'validator', result.note, { findingId, kinds, status: result.status });
  } catch {
    // The finding stands without its pictures.
  }
  return result;
}
