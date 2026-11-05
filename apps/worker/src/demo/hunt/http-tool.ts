// The only way an agent (or the validator) touches the target. Every check here is deterministic code.
import { z } from 'zod';

import { newId } from '@blackwing/ids';

import { checkScope, classifyMethod, gateKey } from './scope.js';

import type { HuntContext } from './context.js';
import type { Gate2Status } from './types.js';

const MS_PER_S = 1000;
const REQUEST_TIMEOUT_S = 10;
const REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_S * MS_PER_S;
const BYTES_PER_KB = 1024;
const STORED_BODY_KB = 64;
const MODEL_BODY_KB = 8;
const STORED_BODY_BYTES = STORED_BODY_KB * BYTES_PER_KB;
const MODEL_BODY_BYTES = MODEL_BODY_KB * BYTES_PER_KB;
const GATE2_POLL_MS = MS_PER_S;
const PAUSE_POLL_MS = 500;
const MAX_METHOD_LENGTH = 16;
const MAX_URL_LENGTH = 4096;
const MAX_BODY_LENGTH = 100_000;
const DROPPED_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

export const probeSchema = z.object({
  method: z.string().min(1).max(MAX_METHOD_LENGTH),
  url: z.string().min(1).max(MAX_URL_LENGTH),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().max(MAX_BODY_LENGTH).optional(),
});
export type HttpRequest = z.infer<typeof probeSchema>;

export type HttpResult =
  | { readonly ok: true; readonly exchangeId: string; readonly status: number; readonly headers: Record<string, string>; readonly body: string; readonly bodyBytes: number }
  | { readonly ok: false; readonly refusal: string };

interface SendOptions {
  readonly purpose: string;
  /** False for validator replays: a state-changing request must already be approved, no new Gate 2 is raised. */
  readonly askGate2: boolean;
}

/** Reads the body and cuts it to at most `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<{ text: string; bytes: number }> {
  const buffer = Buffer.from(await response.arrayBuffer());
  const bytes = Math.min(buffer.byteLength, limit);
  return { text: buffer.subarray(0, limit).toString('utf8'), bytes };
}

async function recordExchange(
  ctx: HuntContext,
  agent: string,
  req: HttpRequest,
  outcome: 'sent' | 'blocked' | 'denied' | 'error',
  extra: { reason?: string; status?: number; headers?: Record<string, string>; body?: string; ms?: number; id?: string },
): Promise<string> {
  const id = extra.id ?? newId();
  ctx.state.exchangeSeq += 1;
  await ctx.store.insertExchange(ctx.run, {
    id,
    seq: ctx.state.exchangeSeq,
    agent,
    method: req.method.toUpperCase(),
    url: req.url,
    requestHeaders: req.headers ?? {},
    requestBody: req.body ?? null,
    status: extra.status ?? null,
    responseHeaders: extra.headers ?? null,
    responseBody: extra.body ?? null,
    durationMs: extra.ms ?? null,
    outcome,
    reason: extra.reason ?? null,
  });
  return id;
}

async function block(ctx: HuntContext, agent: string, req: HttpRequest, rule: string): Promise<HttpResult> {
  await ctx.log.emit('policy.blocked', 'policy', `${agent}: ${req.method.toUpperCase()} ${req.url} refused (${rule})`, {
    agent,
    method: req.method.toUpperCase(),
    url: req.url,
    rule,
  });
  await recordExchange(ctx, agent, req, 'blocked', { reason: rule });
  return { ok: false, refusal: `Refused by policy (${rule}). The request was not sent.` };
}

/** Raises a Gate 2 request and waits for a human. No decision before the deadline means denied. */
async function awaitGate2(ctx: HuntContext, agent: string, req: HttpRequest, url: URL, purpose: string): Promise<Gate2Status> {
  const method = req.method.toUpperCase();
  const id = newId();
  const deadlineAt = new Date(ctx.deps.now() + ctx.deps.gate2TimeoutMs);
  await ctx.store.insertGate2(ctx.run, {
    id,
    agent,
    method,
    url: req.url,
    pathKey: gateKey(method, url),
    reason: purpose,
    whyOutside: `${method} is a state-changing method; the authorisation covers only active-safe requests.`,
    deadlineAt,
  });
  await ctx.log.emit('gate2.requested', 'gate2', `${agent} asks to send ${method} ${url.pathname}`, {
    agent,
    gate2Id: id,
    method,
    url: req.url,
    deadlineAt: deadlineAt.toISOString(),
  });
  let status: Gate2Status = 'pending';
  let by: string | null = null;
  while (status === 'pending') {
    if (ctx.signal.aborted) {
      status = await ctx.store.closeGate2(id, 'denied');
    } else if (ctx.deps.now() >= deadlineAt.getTime()) {
      status = await ctx.store.closeGate2(id, 'expired');
    } else {
      const row = await ctx.store.readGate2(id);
      status = row.status;
      by = row.decidedBy;
      if (status === 'pending') await ctx.deps.sleep(GATE2_POLL_MS);
    }
  }
  await ctx.log.emit('gate2.decided', 'gate2', `Gate 2 ${status} for ${method} ${url.pathname}`, { gate2Id: id, status, ...(by === null ? {} : { by }) });
  return status;
}

export async function sendRequest(ctx: HuntContext, agent: string, req: HttpRequest, options: SendOptions): Promise<HttpResult> {
  const method = req.method.toUpperCase();
  const scope = checkScope(req.url, ctx.run.scope);
  if (!scope.ok) return block(ctx, agent, req, scope.rule);
  const methodClass = classifyMethod(method);
  if (methodClass === 'destructive') return block(ctx, agent, req, 'destructive_method');
  if (ctx.state.requestsUsed >= ctx.run.budgetRequests) return block(ctx, agent, req, 'request_budget');
  if (methodClass === 'state_changing') {
    const key = gateKey(method, scope.url);
    if (!ctx.state.approved.has(key)) {
      if (!options.askGate2) return block(ctx, agent, req, 'gate2_required');
      const decision = await awaitGate2(ctx, agent, req, scope.url, options.purpose);
      if (decision !== 'approved') {
        await recordExchange(ctx, agent, req, 'denied', { reason: `gate2_${decision}` });
        return { ok: false, refusal: `Gate 2 ${decision}: a human did not approve ${key}. The request was not sent.` };
      }
      ctx.state.approved.add(key);
    }
  }
  while (ctx.state.paused && !ctx.signal.aborted) await ctx.deps.sleep(PAUSE_POLL_MS);
  if (ctx.signal.aborted) return { ok: false, refusal: 'The run was halted. The request was not sent.' };

  ctx.state.requestsUsed += 1;
  const headers: Record<string, string> = { 'user-agent': 'blackwing-hunt/1' };
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  }
  const started = ctx.deps.now();
  try {
    const response = await ctx.deps.fetch(scope.url, {
      method,
      headers,
      ...(req.body === undefined ? {} : { body: req.body }),
      redirect: 'manual',
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ctx.signal]),
    });
    const body = await readCapped(response, STORED_BODY_BYTES);
    const ms = ctx.deps.now() - started;
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const exchangeId = await recordExchange(ctx, agent, req, 'sent', { status: response.status, headers: responseHeaders, body: body.text, ms });
    await ctx.log.emit('http.sent', agent, `${agent}: ${method} ${req.url} -> ${response.status}`, {
      agent,
      exchangeId,
      method,
      url: req.url,
      status: response.status,
      bytes: body.bytes,
      ms,
    });
    return { ok: true, exchangeId, status: response.status, headers: responseHeaders, body: body.text, bodyBytes: body.bytes };
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'unknown';
    await recordExchange(ctx, agent, req, 'error', { reason, ms: ctx.deps.now() - started });
    return { ok: false, refusal: `The request failed (${reason}).` };
  }
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
