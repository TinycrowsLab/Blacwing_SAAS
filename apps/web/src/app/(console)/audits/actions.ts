'use server';
/* eslint-disable @typescript-eslint/no-magic-numbers -- the API's field limits (apps/api demo controller LIMITS), checked again here at the boundary */

// The order and Gate 1 (experience spec §3.3, §3.4, §10.4). Each action runs as the signed-in person, validates its
// input with zod (server actions are public endpoints), calls the API and returns an ActionResult: never a redirect, so
// the page keeps what was typed and says what to fix. Conflicts that mean "already done" are mapped to success.
import { z } from 'zod';

import { loadWorkspace, retryOnce, suggestedLimits } from './load';
import { wasApproved } from '../../../components/console/order/shared';
import { type ActionResult, ApiError, callApi, toResult } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { type Asset, assetSchema, type AssessmentRequest, requestSchema } from '../../../lib/schemas';

const enc = encodeURIComponent;
const HTTP_CONFLICT = 409;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVICE_UNAVAILABLE = 503;
const SECONDS_PER_MINUTE = 60;
const REPLACED_REASON = 'Replaced by an edited plan';

const signedOut = {
  ok: false,
  code: 'unauthenticated',
  message: 'Your session ended. Sign in again; your answers are kept on this device.',
  status: HTTP_UNAUTHORIZED,
} as const;

const invalid = (message: string): ActionResult<never> => ({ ok: false, code: 'invalid', message, status: 400 });

const webOrigin = z.url({ protocol: /^https?$/ }).max(2048);
const uuid = z.uuid();

/**
 * Registers the site (or finds it: the API reuses an asset with the same origin). `extraOrigins` are other addresses
 * the app calls (Targets' "This app also calls another address"); they join the scope.
 */
export async function ensureTargetAction(
  origin: string,
  host: string,
  extraOrigins: readonly string[] = [],
): Promise<ActionResult<Asset>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const input = z
    .object({ origin: webOrigin, host: z.string().trim().min(1).max(120), extraOrigins: z.array(webOrigin).max(50) })
    .safeParse({ origin, host, extraOrigins });
  if (!input.success) return invalid("That doesn't look like a web address yet.");
  // Safe to try twice: the API reuses the asset with the same origin, so a retry never adds a second target.
  return toResult(() =>
    retryOnce(async () =>
      assetSchema.parse(
        await callApi(session, '/assets', {
          method: 'POST',
          body: { name: input.data.host, baseUrl: input.data.origin, extraOrigins: input.data.extraOrigins },
        }),
      ),
    ),
  );
}

const verifySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('http_token') }),
  z.object({ method: z.literal('owner_attestation'), statement: z.string().trim().min(10).max(1000) }),
]);
export type VerifyInput = z.infer<typeof verifySchema>;

/** The API's own wait for the file (apps/api demo service VERIFY_TIMEOUT_MS). */
const VERIFY_TIMEOUT_MS = 5000;
/** A check that took this close to the API's wait timed out there: no second fetch, no second wait. */
const TIMEOUT_SLACK_MS = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVER_ERROR = 500;
const HTTP_REDIRECT_MIN = 300;
const HTTP_REDIRECT_MAX = 399;

/** The connection error's code from fetch (undici puts it on `cause`). */
const errorCode = (error: unknown): string => {
  if (error instanceof Error && error.name === 'TimeoutError') return 'TIMEOUT';
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : '';
};

/**
 * Why the file check failed, in plain words ("the name doesn't resolve", "the site answered with a web page").
 * shortcut: the API only says pass or fail, so the console fetches the same well-known URL once more to name the
 * cause (only after a failed check the person asked for). Upgrade when the API returns a cause code.
 */
async function fileCheckCause(url: string, token: string): Promise<string> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
      return `the name ${host} doesn't resolve to an address. Check the spelling, or that the name exists`;
    if (code === 'ECONNREFUSED') return `nothing answered at ${host} (the connection was refused). Check that the site is running`;
    if (code === 'TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')
      return `the site didn't answer within ${VERIFY_TIMEOUT_MS / 1000} seconds`;
    if (/CERT|TLS|SSL/.test(code)) return "the site's HTTPS certificate isn't trusted";
    return `we couldn't connect to ${host}`;
  }
  const status = response.status;
  if (status >= HTTP_REDIRECT_MIN && status <= HTTP_REDIRECT_MAX)
    return `the site redirected to another address (HTTP ${status}). The file must be served at this exact address`;
  if (status === HTTP_NOT_FOUND) return "there's no file there yet (the site answered 404, not found)";
  if (status === HTTP_FORBIDDEN || status === HTTP_UNAUTHORIZED)
    return `the site refused the request (HTTP ${status}). The file must be public`;
  if (status >= HTTP_SERVER_ERROR) return `the site had an error (HTTP ${status})`;
  if (!response.ok) return `the site answered HTTP ${status}`;
  const body = (await response.text().catch(() => '')).slice(0, 65_536);
  if (body.includes(token)) return 'it has just appeared. Press Check now again';
  if (/html/i.test(response.headers.get('content-type') ?? '') || /^\s*</.test(body))
    return "the site answered with a web page, not the file. Check that the file is served at the site root, then try again";
  return 'the file is there, but its content is different. Paste the token exactly, with nothing else';
}

/** Proves ownership by the well-known file or by attestation. "Already verified" (another tab) counts as success. */
export async function verifyTargetAction(assetId: string, verify: VerifyInput): Promise<ActionResult<Asset>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const id = uuid.safeParse(assetId);
  const body = verifySchema.safeParse(verify);
  if (!id.success || !body.success) return invalid('Pick a way to show the site is yours.');
  const started = Date.now();
  const result = await toResult(async () =>
    assetSchema.parse(await callApi(session, `/assets/${enc(id.data)}/verify`, { method: 'POST', body: body.data })),
  );
  const timedOut = Date.now() - started >= VERIFY_TIMEOUT_MS - TIMEOUT_SLACK_MS;
  if (!result.ok && result.status === HTTP_CONFLICT)
    return toResult(async () => assetSchema.parse(await callApi(session, `/assets/${enc(id.data)}`)));
  if (!result.ok && result.code === 'verification_failed') {
    // The URL and token come from the API's own record of the asset, never from the browser.
    const asset = await callApi(session, `/assets/${enc(id.data)}`)
      .then((b) => assetSchema.parse(b))
      .catch(() => null);
    const v = asset?.verification ?? null;
    if (v !== null && v.token !== null)
      return {
        ...result,
        message: timedOut
          ? `the site didn't answer within ${VERIFY_TIMEOUT_MS / 1000} seconds`
          : await fileCheckCause(v.wellKnownUrl, v.token),
      };
  }
  return result;
}

const accountSchema = z.object({
  role: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  headerValue: z.string().min(1).max(4096),
});

const auditSchema = z.object({
  assetId: z.uuid(),
  objective: z.string().trim().min(1).max(2000),
  intrusiveness: z.enum(['passive', 'active_safe']),
  minutes: z.number().int().positive().nullable(),
  requests: z.number().int().positive().nullable(),
  costUsd: z.number().positive().nullable(),
  excludedPaths: z.array(z.string().startsWith('/').max(512)).max(50),
  releaseProven: z.enum(['hold', 'auto']),
  testAccounts: z.array(accountSchema).max(3),
});
export type AuditInput = z.infer<typeof auditSchema>;

async function createRequest(
  session: NonNullable<Awaited<ReturnType<typeof getViewer>>>,
  input: AuditInput,
): Promise<AssessmentRequest> {
  const a = input;
  // The page could not load the workspace's suggestion: read it here, so the order never dead-ends on a reload.
  const limits =
    a.minutes !== null && a.requests !== null && a.costUsd !== null
      ? { minutes: a.minutes, requests: a.requests, costUsd: a.costUsd }
      : suggestedLimits(await loadWorkspace(session));
  // No silent default: the limits are the workspace's (GET /workspace). Say exactly what is missing.
  if (limits === null)
    throw new ApiError(
      HTTP_SERVICE_UNAVAILABLE,
      'limits_unavailable',
      "Blackwing couldn't load your workspace's limits, so the plan can't be prepared yet. Your answers are kept; try again in a moment.",
    );
  return requestSchema.parse(
    await callApi(session, '/requests', {
      method: 'POST',
      body: {
        assetId: a.assetId,
        objective: a.objective,
        intrusiveness: a.intrusiveness,
        budgetRequests: limits.requests,
        budgetSeconds: limits.minutes * SECONDS_PER_MINUTE,
        costCapUsd: limits.costUsd,
        excludedPaths: a.excludedPaths,
        releaseProven: a.releaseProven,
        testAccounts: a.testAccounts,
      },
    }),
  );
}

/** The order's last Continue: the request, pending Gate 1. */
export async function createAuditAction(input: AuditInput): Promise<ActionResult<AssessmentRequest>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const parsed = auditSchema.safeParse(input);
  if (!parsed.success) return invalid('Some answers are missing. Check them and try again.');
  return toResult(() => createRequest(session, parsed.data));
}

/**
 * An edit on the plan while it is pending: a replacement request with the changed answers; the old one is rejected
 * with the reason "Replaced by an edited plan".
 * shortcut: an edit re-creates the request (no PATCH /requests/:id in the API). Upgrade when the API gains one.
 */
export async function replacePlanAction(
  oldId: string,
  input: AuditInput,
): Promise<ActionResult<AssessmentRequest>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const id = uuid.safeParse(oldId);
  const parsed = auditSchema.safeParse(input);
  if (!id.success || !parsed.success) return invalid('That change is not complete yet.');
  const created = await toResult(() => createRequest(session, parsed.data));
  if (!created.ok) return created;
  // Best effort: a person who may not decide their own plans leaves the old one pending; it is never started.
  await callApi(session, `/requests/${enc(id.data)}/decision`, {
    method: 'POST',
    body: { decision: 'reject', reason: REPLACED_REASON },
  }).catch(() => null);
  return created;
}

const reasonSchema = z.string().trim().min(1).max(500);

/** Looks up the run of a request (a second click, or another tab, already started it). */
async function runOf(session: NonNullable<Awaited<ReturnType<typeof getViewer>>>, id: string): Promise<string | null> {
  return requestSchema.parse(await callApi(session, `/requests/${enc(id)}`)).runId;
}

/**
 * Gate 1 and start in one action (spec §3.4): approve, then start the run. A 409 on approve ("already decided") checks
 * the request and continues when it is approved; a 409 on start ("already has a run") returns that run. So a double
 * click, or two tabs, end on the same single run.
 */
export async function approveAndStartAction(
  requestId: string,
  reason: string,
): Promise<ActionResult<{ runId: string }>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const id = uuid.safeParse(requestId);
  const why = reasonSchema.safeParse(reason);
  if (!id.success || !why.success) return invalid('Say why it is safe to run.');
  const approved = await toResult(() =>
    callApi(session, `/requests/${enc(id.data)}/decision`, {
      method: 'POST',
      body: { decision: 'approve', reason: why.data },
    }),
  );
  if (!approved.ok) {
    if (approved.status !== HTTP_CONFLICT) return approved;
    const current = await toResult(async () => requestSchema.parse(await callApi(session, `/requests/${enc(id.data)}`)));
    if (!current.ok) return current;
    if (!wasApproved(current.data.status))
      return { ok: false, code: 'request_not_pending', message: approved.message, status: HTTP_CONFLICT };
    if (current.data.runId !== null) return { ok: true, data: { runId: current.data.runId } };
  }
  try {
    const run = z.object({ id: z.string() }).parse(
      await callApi(session, `/requests/${enc(id.data)}/runs`, { method: 'POST' }),
    );
    return { ok: true, data: { runId: run.id } };
  } catch (error) {
    if (error instanceof ApiError && error.status === HTTP_CONFLICT) {
      const runId = await runOf(session, id.data).catch(() => null);
      if (runId !== null) return { ok: true, data: { runId } };
    }
    return toResult(() => Promise.reject(error instanceof Error ? error : new Error('start failed')));
  }
}

/** Starts the run of a plan approved earlier (when the start did not happen, e.g. a reviewer approved it). */
export async function startAuditAction(requestId: string): Promise<ActionResult<{ runId: string }>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const id = uuid.safeParse(requestId);
  if (!id.success) return invalid('No such plan.');
  const started = await toResult(async () =>
    z.object({ id: z.string() }).parse(await callApi(session, `/requests/${enc(id.data)}/runs`, { method: 'POST' })),
  );
  if (started.ok) return { ok: true, data: { runId: started.data.id } };
  if (started.status === HTTP_CONFLICT) {
    const runId = await runOf(session, id.data).catch(() => null);
    if (runId !== null) return { ok: true, data: { runId } };
  }
  return started;
}

/** A reviewer's Deny at Gate 1. A reason is required. */
export async function denyPlanAction(requestId: string, reason: string): Promise<ActionResult<AssessmentRequest>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const id = uuid.safeParse(requestId);
  const why = reasonSchema.safeParse(reason);
  if (!id.success || !why.success) return invalid('Say why you deny it.');
  return toResult(async () =>
    requestSchema.parse(
      await callApi(session, `/requests/${enc(id.data)}/decision`, {
        method: 'POST',
        body: { decision: 'reject', reason: why.data },
      }),
    ),
  );
}
