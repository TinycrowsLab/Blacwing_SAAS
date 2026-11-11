// The only way an agent (or the validator) touches the target. Every check here is deterministic code.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, isIPv4 } from 'node:net';

import { z } from 'zod';

import { scrub, scrubHeaders } from '@blackwing/errors/scrub';
import { newId } from '@blackwing/ids';

import { applySetCookies, cookieHeader, MAX_LOGINS, newSession, performLogin, redirectsToLogin, type Session, type Step } from './login.js';
import { checkScope, classifyMethod, gateKey, stateChangeHint } from './scope.js';
import { isDisallowedAddress } from '../../run/preflight/address-guard.js';

import type { Gate2Ask, HuntContext } from './context.js';
import type { Gate2Status } from './types.js';

const MS_PER_S = 1000;
const REQUEST_TIMEOUT_S = 10;
const REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_S * MS_PER_S;
const BYTES_PER_KB = 1024;
const STORED_BODY_KB = 64;
const MODEL_BODY_KB = 8;
/** Scrubbed past the stored cut, so a secret that straddles the cut is still recognised. */
const SCRUB_MARGIN_KB = 4;
const STORED_BODY_BYTES = STORED_BODY_KB * BYTES_PER_KB;
const MODEL_BODY_BYTES = MODEL_BODY_KB * BYTES_PER_KB;
const SCRUB_MARGIN_BYTES = SCRUB_MARGIN_KB * BYTES_PER_KB;
export const GATE2_POLL_MS = MS_PER_S;
/** The Gate 2 card shows the exact request body; it is clamped in the event. */
const GATE2_BODY_MAX_CHARS = 2048;
const PAUSE_POLL_MS = 500;
const MAX_METHOD_LENGTH = 16;
const MAX_URL_LENGTH = 4096;
const MAX_BODY_LENGTH = 100_000;
const MAX_ROLE_LENGTH = 32;
/** `accounts.unused` fires at the latest after this many sent requests without any test-account use. */
const ACCOUNTS_UNUSED_AFTER = 25;
const REDACTED = '[redacted]';
const MIN_SESSION_SECRET = 8;
const HTTP_OK = 200;
const HTTP_ERROR_MIN = 400;
const LOGOUT_PATH = /log-?out|sign-?out/i;
const USER_AGENT = 'blackwing-hunt/1';
const DROPPED_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

/** Never reachable, not even for an operator-listed lab origin: link-local (cloud metadata), unspecified, provider metadata IPs. */
const ALWAYS_REFUSED = new BlockList();
for (const cidr of ['169.254.0.0/16', '0.0.0.0/8', '100.100.100.200/32', 'fe80::/10', '::/128', 'fd00:ec2::254/128']) {
  const [net = '', prefix = ''] = cidr.split('/');
  ALWAYS_REFUSED.addSubnet(net, Number(prefix), isIPv4(net) ? 'ipv4' : 'ipv6');
}
const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export const probeSchema = z.object({
  method: z.string().min(1).max(MAX_METHOD_LENGTH),
  url: z.string().min(1).max(MAX_URL_LENGTH),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().max(MAX_BODY_LENGTH).optional(),
  as_role: z.string().max(MAX_ROLE_LENGTH).optional().describe('Send as this test account role; the runner adds its credential header'),
});
export type HttpRequest = z.infer<typeof probeSchema>;

/** The request as it went on the wire: lower-case header names, the credential as `[redacted: role <r>]`, then scrubbed. */
export interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
  readonly asRole: string | null;
}

/** `headers` and `body` of a sent result are the model's view: raw except configured test-account values. */
export type HttpResult =
  | { readonly ok: true; readonly exchangeId: string; readonly status: number; readonly headers: Record<string, string>; readonly body: string; readonly bodyBytes: number; readonly request: SentRequest }
  | { readonly ok: false; readonly refusal: string; readonly pending?: true; readonly gate2Id?: string };

interface SendOptions {
  readonly purpose: string;
  /** False for validator replays: a state-changing request must already be approved, no new Gate 2 is raised. */
  readonly askGate2: boolean;
  /** The recorded test case this request belongs to (counted for coverage when known). */
  readonly caseId?: string | undefined;
}

function cutBytes(text: string, limit: number): string {
  return Buffer.from(text).subarray(0, limit).toString('utf8');
}

/** Every test-account credential as it may come back: the full header value, the bare token after the scheme, and their JSON-escaped forms. */
function secretsOf(accounts: HuntContext['run']['testAccounts'], sessions: ReadonlyMap<string, Session>, inRequest: boolean): string[] {
  const values = accounts.flatMap((a) => [
    a.headerValue,
    a.headerValue.slice(a.headerValue.indexOf(' ') + 1),
    // A short password (DVWA's `password`) would garble every page that uses the word, so it is redacted only in what we send.
    ...(a.login === undefined || (!inRequest && a.login.password.length < MIN_SESSION_SECRET)
      ? []
      : [a.login.password, new URLSearchParams({ p: a.login.password }).toString().slice(2), encodeURIComponent(a.login.password)]),
  ]);
  // Session cookies of a login-form account stay inside the runner (short values such as `security=low` are not secrets).
  for (const session of sessions.values()) for (const value of session.jar.values()) if (value.length >= MIN_SESSION_SECRET) values.push(value);
  return [...new Set(values.flatMap((v) => [v, v.replaceAll('/', '\\/')]))]
    .filter((v) => v !== '')
    .sort((a, b) => b.length - a.length);
}

function redactor(ctx: HuntContext, inRequest = false): (text: string) => string {
  const secrets = secretsOf(ctx.run.testAccounts, ctx.state.sessions, inRequest);
  return (text) => secrets.reduce((acc, secret) => acc.replaceAll(secret, REDACTED), text);
}

/** Stored form of a request that was not sent: the model's headers and body, scrubbed. */
function unsentRequest(ctx: HuntContext, req: HttpRequest): SentRequest {
  const redact = redactor(ctx, true);
  return {
    method: req.method.toUpperCase(),
    url: scrub(req.url),
    headers: scrubHeaders(Object.fromEntries(Object.entries(req.headers ?? {}).map(([name, value]) => [name, redact(value)]))),
    body: req.body === undefined ? null : scrub(redact(req.body)),
    asRole: req.as_role ?? null,
  };
}

async function recordExchange(
  ctx: HuntContext,
  agent: string,
  request: SentRequest,
  outcome: 'sent' | 'blocked' | 'denied' | 'error',
  extra: { reason?: string; status?: number; headers?: Record<string, string>; body?: string; ms?: number; id?: string },
): Promise<string> {
  const id = extra.id ?? newId();
  ctx.state.exchangeSeq += 1;
  await ctx.store.insertExchange(ctx.run, {
    id,
    seq: ctx.state.exchangeSeq,
    agent,
    method: request.method,
    url: request.url,
    requestHeaders: request.headers,
    requestBody: request.body,
    status: extra.status ?? null,
    responseHeaders: extra.headers === undefined ? null : scrubHeaders(extra.headers),
    responseBody: extra.body ?? null,
    durationMs: extra.ms ?? null,
    outcome,
    reason: extra.reason ?? null,
  });
  return id;
}

async function block(ctx: HuntContext, agent: string, req: HttpRequest, rule: string, refusal?: string): Promise<HttpResult> {
  const request = unsentRequest(ctx, req);
  await ctx.log.emit('policy.blocked', 'policy', `${agent}: ${request.method} ${request.url} refused (${rule})`, {
    agent,
    method: request.method,
    url: request.url,
    rule,
  });
  await recordExchange(ctx, agent, request, 'blocked', { reason: rule });
  return { ok: false, refusal: refusal ?? `Refused by policy (${rule}). The request was not sent.` };
}

function alwaysRefused(address: string): boolean {
  const candidate = V4_MAPPED.exec(address)?.[1] ?? address;
  if (isIP(candidate) === 0) return true;
  return ALWAYS_REFUSED.check(candidate, isIPv4(candidate) ? 'ipv4' : 'ipv6');
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const defaultLookup = (hostname: string): Promise<readonly { address: string }[]> => dnsLookup(hostname, { all: true });

/**
 * Private-range guard at send time. An operator-listed lab origin may resolve to loopback or a private range, never
 * to link-local, metadata or unspecified addresses; any other origin must resolve to public addresses only.
 * Returns the refusing rule, or null. Residual: DNS can change between this lookup and the connect.
 */
async function addressRule(ctx: HuntContext, url: URL): Promise<'private_address' | 'dns_failed' | null> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses: readonly { address: string }[];
  try {
    addresses = await (ctx.deps.lookup ?? defaultLookup)(host);
  } catch {
    return 'dns_failed';
  }
  if (addresses.length === 0) return 'dns_failed';
  const lab = ctx.run.labOrigins.some((origin) => originOf(origin) === url.origin);
  return addresses.some(({ address }) => (lab ? alwaysRefused(address) : isDisallowedAddress(address))) ? 'private_address' : null;
}

function latestAsk(ctx: HuntContext, key: string): Gate2Ask | undefined {
  let found: Gate2Ask | undefined;
  for (const ask of ctx.state.asks.values()) if (ask.key === key) found = ask;
  return found;
}

function pendingResult(ask: Gate2Ask): HttpResult {
  return {
    ok: false,
    pending: true,
    gate2Id: ask.id,
    refusal: `Waiting for a human (Gate 2 ${ask.id}) to allow ${ask.label}. It was not sent. Carry on with other test cases; send it again later, or call await_decision when nothing else is left.`,
  };
}

/** Raises a Gate 2 request and returns at once: the watcher delivers the decision later as a notice. */
async function raiseGate2(ctx: HuntContext, agent: string, req: HttpRequest, url: URL, options: SendOptions, role: string | undefined): Promise<HttpResult> {
  const method = req.method.toUpperCase();
  const identity = role === undefined ? 'without a test account credential' : `as test account role ${role}`;
  const hint = stateChangeHint(method, url);
  const why = hint === null ? `${method} is a state-changing method` : `This ${method} may change state (${hint})`;
  const id = newId();
  const deadlineAt = new Date(ctx.deps.now() + ctx.deps.gate2TimeoutMs);
  // Agent-authored; test-account credentials are injected as headers by the runner, never into the body.
  const body = req.body === undefined ? null : scrub(redactor(ctx, true)(req.body)).slice(0, GATE2_BODY_MAX_CHARS);
  const key = gateKey(method, url, role);
  const ask: Gate2Ask = { id, key, label: `${method} ${url.pathname} as ${role ?? 'no test account'}`, agent, caseId: options.caseId ?? null, deadlineAt: deadlineAt.getTime(), status: 'pending' };
  await ctx.store.insertGate2(ctx.run, {
    id,
    agent,
    method,
    url: scrub(req.url),
    pathKey: key,
    reason: options.purpose,
    whyOutside: `${why}; the authorisation covers only active-safe requests. It would be sent ${identity}.`,
    deadlineAt,
    body,
    asRole: role ?? null,
  });
  ctx.state.asks.set(id, ask);
  await ctx.log.emit('gate2.requested', 'gate2', `${agent} asks to send ${method} ${url.pathname} ${identity}`, {
    agent,
    gate2Id: id,
    method,
    url: scrub(req.url),
    ...(role === undefined ? {} : { asRole: role }),
    body: body ?? '',
    deadlineAt: deadlineAt.toISOString(),
    blocking: false,
    ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
  });
  return pendingResult(ask);
}

function noticeText(ask: Gate2Ask, status: Gate2Status): string {
  return status === 'approved'
    ? `Gate 2 approved: ${ask.label}. Send it again now.`
    : `Gate 2 ${status === 'expired' ? 'expired (no answer in time)' : 'denied'}: ${ask.label}. It was not sent; do not ask for it again.`;
}

/** Moves an ask out of `pending` once (idempotent across concurrent watchers), emits `gate2.decided` and queues a notice. */
async function settleAsk(ctx: HuntContext, ask: Gate2Ask, status: Gate2Status, detail: { by?: string | null; reason?: string }): Promise<void> {
  if (ask.status !== 'pending' || status === 'pending') return;
  ask.status = status;
  if (detail.reason === 'run_ended' || detail.reason === 'killed') ask.closedUnanswered = true;
  const queued = ctx.state.notices.get(ask.agent) ?? [];
  queued.push({ gate2Id: ask.id, text: noticeText(ask, status) });
  ctx.state.notices.set(ask.agent, queued);
  await ctx.log.emit('gate2.decided', 'gate2', `Gate 2 ${status} for ${ask.label}`, {
    gate2Id: ask.id,
    status,
    ...(detail.by === undefined || detail.by === null ? {} : { by: detail.by }),
    ...(detail.reason === undefined ? {} : { reason: detail.reason }),
  });
}

/** One watcher pass over the run's pending asks: picks up human decisions and expires asks past their deadline. */
export async function watchGate2(ctx: HuntContext): Promise<void> {
  for (const ask of ctx.state.asks.values()) {
    if (ask.status !== 'pending') continue;
    if (ctx.deps.now() >= ask.deadlineAt) {
      await settleAsk(ctx, ask, await ctx.store.closeGate2(ask.id, 'expired', 'deadline'), { reason: 'deadline' });
    } else {
      const row = await ctx.store.readGate2(ask.id);
      await settleAsk(ctx, ask, row.status, { by: row.decidedBy });
    }
  }
}

/** Run end: every ask still pending is closed unanswered (`expired`, ledgered) in the store, one `gate2.decided` each. */
export async function closePendingAsks(ctx: HuntContext, reason: 'run_ended' | 'killed'): Promise<void> {
  for (const id of await ctx.store.closePendingGate2(ctx.run.id, reason)) {
    const ask = ctx.state.asks.get(id);
    if (ask === undefined) await ctx.log.emit('gate2.decided', 'gate2', 'Gate 2 not answered before the audit ended', { gate2Id: id, status: 'expired', reason });
    else await settleAsk(ctx, ask, 'expired', { reason });
  }
}

/** Gate 2 outcomes the agent has not seen yet; each is returned once. `except` drops one the caller reports itself. */
export function takeNotices(ctx: HuntContext, agent: string, except?: string): string[] {
  const queued = ctx.state.notices.get(agent) ?? [];
  ctx.state.notices.delete(agent);
  return queued.filter((n) => n.gate2Id !== except).map((n) => n.text);
}

/** Sleeps `ms`, or returns the moment the run is stopped, so a kill never waits out a poll interval. */
export async function sleepUnlessStopped(ctx: HuntContext, ms: number): Promise<void> {
  if (ctx.signal.aborted) return;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    onAbort = () => {
      resolve();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([ctx.deps.sleep(ms), stopped]);
  } finally {
    if (onAbort !== undefined) ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** Waits (honouring pause and kill) for a human to decide one ask, at most `maxMs` of unpaused time. */
export async function awaitDecision(ctx: HuntContext, gate2Id: string, maxMs: number): Promise<Gate2Status | 'unknown' | 'halted'> {
  const ask = ctx.state.asks.get(gate2Id);
  if (ask === undefined) return 'unknown';
  let waited = 0;
  while (ask.status === 'pending' && !ctx.signal.aborted && (ctx.state.paused || waited < maxMs)) {
    await sleepUnlessStopped(ctx, GATE2_POLL_MS);
    if (!ctx.state.paused) waited += GATE2_POLL_MS;
    await watchGate2(ctx);
  }
  return ctx.signal.aborted ? 'halted' : ask.status;
}

/** Counts a sent request for its role and test case, and warns once when configured test accounts go unused. */
async function countSent(ctx: HuntContext, agent: string, role: string | undefined, caseId: string | undefined): Promise<void> {
  if (role !== undefined) ctx.state.roleCounts.set(role, (ctx.state.roleCounts.get(role) ?? 0) + 1);
  const testCase = caseId === undefined ? undefined : ctx.state.cases.get(caseId);
  if (testCase !== undefined) testCase.requests += 1;
  const roles = ctx.run.testAccounts.map((a) => a.role);
  if (roles.length === 0 || ctx.state.accountsWarned || ctx.state.roleCounts.size > 0) return;
  if (agent === 'recon' && ctx.state.requestsUsed < ACCOUNTS_UNUSED_AFTER) return;
  ctx.state.accountsWarned = true;
  await ctx.log.emit('accounts.unused', 'policy', `No request has used your test accounts yet (${roles.join(', ')}).`, { roles, sentSoFar: ctx.state.requestsUsed });
}

export const LOGIN_WALL_MESSAGE = 'Most of this site is behind a login; add a test account to test it.';
const LOGIN_WALL_MIN_REDIRECTS = 3;

/** Signed-out recon: when most distinct pages redirect to a login page and no test account exists, say so once. */
async function noteSignedOut(ctx: HuntContext, url: URL, status: number, location: string | null): Promise<void> {
  if (status >= HTTP_ERROR_MIN) return;
  if (ctx.run.testAccounts.length > 0 || ctx.state.loginWall) return;
  const toLogin = redirectsToLogin({ status, location }, url.href, null);
  ctx.state.signedOutPaths.set(url.pathname, (ctx.state.signedOutPaths.get(url.pathname) ?? false) || toLogin);
  const redirected = [...ctx.state.signedOutPaths.values()].filter(Boolean).length;
  if (redirected < LOGIN_WALL_MIN_REDIRECTS || redirected * 2 < ctx.state.signedOutPaths.size) return;
  ctx.state.loginWall = true;
  await ctx.log.emit('login.wall', 'recon', LOGIN_WALL_MESSAGE, { redirectedPages: redirected, pagesSeen: ctx.state.signedOutPaths.size });
}

/** One runner request for a sign-in: scope, private-range guard, budget and kill apply as for any request; no Gate 2. */
function runnerStep(ctx: HuntContext, role: string): Step {
  return async (req) => {
    const scope = checkScope(req.url, ctx.run.scope);
    if (!scope.ok || ctx.signal.aborted || ctx.state.requestsUsed >= ctx.run.budgetRequests) return null;
    if ((await addressRule(ctx, scope.url)) !== null) return null;
    ctx.state.requestsUsed += 1;
    const redact = redactor(ctx);
    const request: SentRequest = {
      method: req.method,
      url: scrub(req.url),
      headers: scrubHeaders(Object.fromEntries(Object.entries(req.headers).map(([n, v]) => [n, n.toLowerCase() === 'cookie' ? `[redacted: role ${role}]` : v]))),
      body: req.body === undefined ? null : scrub(redactor(ctx, true)(req.body)),
      asRole: role,
    };
    const started = ctx.deps.now();
    try {
      const response = await ctx.deps.fetch(scope.url, {
        method: req.method,
        headers: { 'user-agent': USER_AGENT, ...req.headers },
        ...(req.body === undefined ? {} : { body: req.body }),
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ctx.signal]),
      });
      const raw = Buffer.from(await response.arrayBuffer()).toString('utf8');
      const body = cutBytes(redact(raw), STORED_BODY_BYTES);
      const ms = ctx.deps.now() - started;
      const exchangeId = await recordExchange(ctx, 'runner', request, 'sent', { status: response.status, headers: Object.fromEntries([...response.headers.entries()].map(([n, v]) => [n, redact(v)])), body: scrub(body), ms });
      await ctx.log.emit('http.sent', 'runner', `runner: ${req.method} ${request.url} -> ${response.status} (sign-in)`, { agent: 'runner', exchangeId, method: req.method, url: request.url, status: response.status, bytes: body.length, ms, asRole: role });
      return { status: response.status, location: response.headers.get('location'), setCookies: response.headers.getSetCookie(), body: raw };
    } catch (error) {
      await recordExchange(ctx, 'runner', request, 'error', { reason: error instanceof Error ? error.name : 'unknown', ms: ctx.deps.now() - started });
      return null;
    }
  };
}

/**
 * Makes sure a login-form account has a live session, signing in through the runner (the model never sees the
 * credentials or the cookies). `force` signs in again after a lost session, at most MAX_LOGINS times per run.
 * A failed first sign-in is final for the run. Parallel callers share one sign-in.
 */
export async function ensureSession(ctx: HuntContext, account: HuntContext['run']['testAccounts'][number], force: boolean): Promise<boolean> {
  const login = account.login;
  if (login === undefined) return true;
  const key = account.role.toLowerCase();
  let session = ctx.state.sessions.get(key);
  if (session === undefined) {
    session = newSession();
    ctx.state.sessions.set(key, session);
  }
  const current = session;
  if (current.pending !== null) return current.pending;
  if (current.failure !== null) return false;
  if (current.logins > 0 && !force) return true;
  if (current.logins >= MAX_LOGINS) return false;
  current.pending = (async () => {
    current.logins += 1;
    const origin = ctx.run.scope.allowedOrigins[0] ?? '';
    const failure = await performLogin({ role: account.role, ...login }, origin, current, runnerStep(ctx, account.role));
    current.failure = failure;
    if (failure === null) await ctx.log.emit('login.performed', 'policy', `Signed in as test account "${account.role}" through the login form (sign-in ${current.logins})`, { role: account.role, logins: current.logins });
    else await ctx.log.emit('login.failed', 'policy', `Sign-in as test account "${account.role}" failed: ${failure} Requests as this role are not sent.`, { role: account.role, reason: failure });
    return failure === null;
  })().finally(() => {
    current.pending = null;
  });
  return current.pending;
}

export async function sendRequest(ctx: HuntContext, agent: string, req: HttpRequest, options: SendOptions): Promise<HttpResult> {
  const method = req.method.toUpperCase();
  const scope = checkScope(req.url, ctx.run.scope);
  if (!scope.ok) return block(ctx, agent, req, scope.rule);
  const methodClass = classifyMethod(method, scope.url);
  if (methodClass === 'destructive') return block(ctx, agent, req, 'destructive_method');
  if (ctx.run.intrusiveness === 'passive' && methodClass !== 'active_safe') return block(ctx, agent, req, 'above_max_intrusiveness');
  const account = req.as_role === undefined ? undefined : ctx.run.testAccounts.find((a) => a.role.toLowerCase() === req.as_role?.toLowerCase());
  if (req.as_role !== undefined && account === undefined) return block(ctx, agent, req, 'unknown_role');
  if (ctx.state.requestsUsed >= ctx.run.budgetRequests) return block(ctx, agent, req, 'request_budget');
  let gate2Id: string | undefined;
  if (methodClass === 'state_changing') {
    const ask = latestAsk(ctx, gateKey(method, scope.url, account?.role));
    if (ask?.status !== 'approved') {
      if (!options.askGate2) return block(ctx, agent, req, 'gate2_required');
      if (ask?.status === 'pending') return pendingResult(ask);
      if (ask !== undefined) {
        const rule = ask.status === 'expired' ? 'gate2_expired' : 'gate2_denied';
        const when = ask.status === 'expired' ? 'got no answer in time' : 'was denied by a human';
        return block(ctx, agent, req, rule, `Gate 2 ${ask.id} for ${ask.label} ${when} earlier in this run. It was not sent. Do not ask for it again; move on.`);
      }
      return raiseGate2(ctx, agent, req, scope.url, options, account?.role);
    }
    gate2Id = ask.id;
  }
  while (ctx.state.paused && !ctx.signal.aborted) await sleepUnlessStopped(ctx, PAUSE_POLL_MS);
  if (ctx.signal.aborted) return { ok: false, refusal: 'The run was halted. The request was not sent.' };
  // Re-check after the pause wait: parallel agents may have used the budget meanwhile.
  if (ctx.state.requestsUsed >= ctx.run.budgetRequests) return block(ctx, agent, req, 'request_budget');
  const addressBlock = await addressRule(ctx, scope.url);
  if (addressBlock === 'private_address') return block(ctx, agent, req, 'private_address');
  if (addressBlock === 'dns_failed') {
    await recordExchange(ctx, agent, unsentRequest(ctx, req), 'error', { reason: 'dns_failed' });
    return { ok: false, refusal: 'The request failed (the host name did not resolve). It was not sent.' };
  }

  if (account?.login !== undefined && !(await ensureSession(ctx, account, false))) {
    const why = ctx.state.sessions.get(account.role.toLowerCase())?.failure ?? 'the sign-in could not run';
    return { ok: false, refusal: `Signing in as test account "${account.role}" failed (${why}). The request was not sent; do not retry as this role.` };
  }
  if (ctx.state.requestsUsed >= ctx.run.budgetRequests) return block(ctx, agent, req, 'request_budget');
  ctx.state.requestsUsed += 1;
  const headers: Record<string, string> = { 'user-agent': USER_AGENT };
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  }
  const session = account?.login === undefined ? undefined : ctx.state.sessions.get(account.role.toLowerCase());
  if (account !== undefined && session === undefined) headers[account.headerName.toLowerCase()] = account.headerValue;
  const withJar = (): void => {
    if (session === undefined) return;
    const cookie = cookieHeader(session.jar, req.headers === undefined ? undefined : Object.entries(req.headers).find(([n]) => n.toLowerCase() === 'cookie')?.[1]);
    if (cookie !== '') headers.cookie = cookie;
  };
  withJar();
  let redact = redactor(ctx);
  const credentialName = session === undefined ? account?.headerName : 'Cookie';
  const sentHeaders = { ...headers, ...(account === undefined || credentialName === undefined ? {} : { [credentialName.toLowerCase()]: `[redacted: role ${account.role}]` }) };
  const request: SentRequest = {
    method,
    url: scrub(req.url),
    headers: scrubHeaders(Object.fromEntries(Object.entries(sentHeaders).map(([name, value]) => [name, redact(value)]))),
    body: req.body === undefined ? null : scrub(redactor(ctx, true)(req.body)),
    asRole: account?.role ?? null,
  };
  const started = ctx.deps.now();
  try {
    const doFetch = (): Promise<Response> =>
      ctx.deps.fetch(scope.url, {
        method,
        headers,
        ...(req.body === undefined ? {} : { body: req.body }),
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ctx.signal]),
      });
    let response = await doFetch();
    if (session !== undefined) {
      // Session lost (redirect to the login page): sign in again once and resend; the resend counts against the budget.
      const lost = redirectsToLogin({ status: response.status, location: response.headers.get('location') }, scope.url.href, session.loginPath);
      if (lost && !LOGOUT_PATH.test(scope.url.pathname) && account !== undefined && (await ensureSession(ctx, account, true)) && ctx.state.requestsUsed < ctx.run.budgetRequests) {
        withJar();
        ctx.state.requestsUsed += 1;
        response = await doFetch();
      }
      applySetCookies(session.jar, response.headers.getSetCookie());
      redact = redactor(ctx);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const bytes = Math.min(buffer.byteLength, STORED_BODY_BYTES);
    // Configured credentials are redacted before cutting, so none is split at the cut. The model sees the rest raw
    // (it needs an obtained token to test); what is stored is scrubbed of every other secret as well.
    const full = redact(buffer.toString('utf8'));
    const body = cutBytes(full, STORED_BODY_BYTES);
    const ms = ctx.deps.now() - started;
    const responseHeaders = Object.fromEntries([...response.headers.entries()].map(([name, value]) => [name, redact(value)]));
    const exchangeId = await recordExchange(ctx, agent, request, 'sent', {
      status: response.status,
      headers: responseHeaders,
      body: cutBytes(scrub(cutBytes(full, STORED_BODY_BYTES + SCRUB_MARGIN_BYTES)), STORED_BODY_BYTES),
      ms,
    });
    await ctx.log.emit('http.sent', agent, `${agent}: ${method} ${request.url} -> ${response.status}`, {
      agent,
      exchangeId,
      method,
      url: request.url,
      status: response.status,
      bytes,
      ms,
      ...(account === undefined ? {} : { asRole: account.role }),
      ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
      ...(gate2Id === undefined ? {} : { gate2Id }),
    });
    await countSent(ctx, agent, account?.role, options.caseId);
    if (agent !== 'validator') noteSurface(ctx, scope.url, response.status, body, response.headers.get('content-type'));
    if (agent !== 'validator' && response.status === HTTP_OK && (scope.url.search !== '' || /<form\b/i.test(body))) ctx.state.inputsSeen += 1;
    if (account === undefined && agent !== 'validator') await noteSignedOut(ctx, scope.url, response.status, response.headers.get('location'));
    const approvedAsk = gate2Id === undefined ? undefined : ctx.state.asks.get(gate2Id);
    if (approvedAsk !== undefined && agent !== 'validator') approvedAsk.sent = true;
    return { ok: true, exchangeId, status: response.status, headers: responseHeaders, body, bodyBytes: bytes, request };
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    await recordExchange(ctx, agent, request, 'error', { reason, ms: ctx.deps.now() - started });
    return { ok: false, refusal: `The request failed (${reason}).` };
  }
}

const ASSET_PATH = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|mp4|mp3|pdf|zip|gz)$/i;
const LINK_ATTR = /\b(?:href|action|src)\s*=\s*["']([^"'#\s]+)["']/gi;
const MAX_TRACKED = 400;
const SINK_HINT = /document\.(?:write|location)|location\.(?:href|hash|search|assign|replace)|\.innerHTML|\beval\(|window\.open|postMessage/;

/** Lower-case in-scope path of a link, or null for another origin, a non-page link or a path the run must not touch. */
function pagePath(ctx: HuntContext, base: URL, link: string, assets: boolean): string | null {
  let url: URL;
  try {
    url = new URL(link, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.origin !== base.origin) return null;
  const path = url.pathname.replace(/\/{2,}/g, '/').toLowerCase();
  if (!assets && ASSET_PATH.test(path)) return null;
  if (ctx.run.scope.excludedPaths.some((p) => path.startsWith(p.toLowerCase()))) return null;
  return path;
}

/** What the run has seen of the site, for the completion check: pages requested, pages linked, forms, script sinks. */
function noteSurface(ctx: HuntContext, url: URL, status: number, body: string, contentType: string | null): void {
  const { visited, linked, formPages, scriptHints } = ctx.state;
  const here = pagePath(ctx, url, url.href, true);
  if (here === null) return;
  if (visited.size < MAX_TRACKED) visited.add(here);
  if (status !== HTTP_OK) return;
  if (url.search !== '' || /<form\b/i.test(body)) formPages.add(here);
  if (/javascript|ecmascript/i.test(contentType ?? '') || /\.m?js$/.test(here)) {
    if (SINK_HINT.test(body) && scriptHints.size < MAX_TRACKED) scriptHints.add(here);
    return;
  }
  if (!/html/i.test(contentType ?? '') && !/<a\s|<form\b/i.test(body)) return;
  for (const match of body.matchAll(LINK_ATTR)) {
    const path = pagePath(ctx, url, match[1] ?? '', false);
    if (path !== null && linked.size < MAX_TRACKED) linked.add(path);
  }
  if (SINK_HINT.test(body) && /<script\b/i.test(body) && scriptHints.size < MAX_TRACKED) scriptHints.add(here);
}

/** What the model sees of a response: headers as sent, body cut at 8 KB and marked when truncated. */
export function modelView(result: Extract<HttpResult, { ok: true }>): { exchangeId: string; status: number; headers: Record<string, string>; body: string; truncated: boolean } {
  const bytes = Buffer.from(result.body, 'utf8');
  const truncated = bytes.byteLength > MODEL_BODY_BYTES;
  return {
    exchangeId: result.exchangeId,
    status: result.status,
    headers: result.headers,
    body: truncated ? bytes.subarray(0, MODEL_BODY_BYTES).toString('utf8') : result.body,
    truncated,
  };
}
