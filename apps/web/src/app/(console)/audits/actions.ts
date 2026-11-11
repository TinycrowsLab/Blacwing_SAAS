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

const signedOut = {
  ok: false,
  code: 'unauthenticated',
  message: 'Your session ended. Sign in again; your answers are kept on this device.',
  status: HTTP_UNAUTHORIZED,
} as const;

const invalid = (message: string): ActionResult<never> => ({ ok: false, code: 'invalid', message, status: 400 });

/**
 * Ownership refusals in plain words, with the one fix. The API's own detail names the cause (it is already plain);
 * these add what to do next.
 */
function plainOwnership<T>(result: ActionResult<T>): ActionResult<T> {
  if (result.ok) return result;
  switch (result.code) {
    case 'ownership_recheck_failed':
      return {
        ...result,
        // The API's detail already says what changed; only the way forward is the console's.
        // An address the rules now refuse cannot be proven again, so it gets no "show it again".
        message: result.message.replace(
          /\s*Prove ownership again to go ahead\.?$/,
          /can never be tested|cannot test its own|listed it as a lab/.test(result.message)
            ? ''
            : ' Show it is yours again on Targets, then try again.',
        ),
      };
    default:
      return result;
  }
}

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
  return plainOwnership(
    await toResult(() =>
      retryOnce(async () =>
        assetSchema.parse(
          await callApi(session, '/assets', {
            method: 'POST',
            body: { name: input.data.host, baseUrl: input.data.origin, extraOrigins: input.data.extraOrigins },
          }),
        ),
      ),
    ),
  );
}

const draftInput = z.object({
  id: uuid,
  step: z.number().int().min(1).max(4),
  answers: z.record(z.string().max(120), z.unknown()),
});

/** Keeps the order's answers on the server (per person), so the draft's link restores them in any browser. */
export async function saveDraftAction(id: string, step: number, answers: Record<string, unknown>): Promise<ActionResult<{ saved: true }>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const input = draftInput.safeParse({ id, step, answers });
  if (!input.success) return invalid('That draft could not be saved.');
  return toResult(async () => {
    await callApi(session, `/drafts/${input.data.id}`, { method: 'PUT', body: { step: input.data.step, answers: input.data.answers } });
    return { saved: true as const };
  });
}

/** Drops the server copy of a draft (the order was placed, or the address was refused). */
export async function discardDraftAction(id: string): Promise<ActionResult<{ discarded: true }>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  if (!uuid.safeParse(id).success) return invalid('That draft could not be found.');
  return toResult(async () => {
    await callApi(session, `/drafts/${id}`, { method: 'DELETE' });
    return { discarded: true as const };
  });
}

/** Removes a target from the list (the API keeps it in the ledger and for past runs; refused while an audit is open). */
export async function removeTargetAction(assetId: string): Promise<ActionResult<{ removed: true }>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  if (!uuid.safeParse(assetId).success) return invalid('That target could not be found.');
  return toResult(async () => {
    await callApi(session, `/assets/${assetId}`, { method: 'DELETE' });
    return { removed: true as const };
  });
}

const verifySchema = z.object({ method: z.literal('owner_attestation'), statement: z.string().trim().min(10).max(1000) });
export type VerifyInput = z.infer<typeof verifySchema>;

/** Records the owner's attestation. "Already verified" (another tab) counts as success. */
export async function verifyTargetAction(assetId: string, verify: VerifyInput): Promise<ActionResult<Asset>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const id = uuid.safeParse(assetId);
  const body = verifySchema.safeParse(verify);
  if (!id.success || !body.success) return invalid('Tick the box to confirm you are authorised to test the site.');
  const result = await toResult(async () =>
    assetSchema.parse(await callApi(session, `/assets/${enc(id.data)}/verify`, { method: 'POST', body: body.data })),
  );
  if (!result.ok && result.status === HTTP_CONFLICT)
    return toResult(async () => assetSchema.parse(await callApi(session, `/assets/${enc(id.data)}`)));
  return plainOwnership(result);
}

const accountRole = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
const headerAccount = z.object({
  role: accountRole,
  headerName: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  headerValue: z.string().min(1).max(4096),
});
/** Login-form mode: Blackwing signs in with the username and password itself. */
const loginAccount = z.object({
  role: accountRole,
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
  loginUrl: z.url({ protocol: /^https?$/ }).max(2048).optional(),
});
const accountSchema = z.union([headerAccount, loginAccount]);

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

/** A saved account keeps its stored value when `headerValue` is left out (the API never sends values back). */
const amendSchema = z.object({
  version: z.number().int().min(1),
  objective: auditSchema.shape.objective.optional(),
  intrusiveness: auditSchema.shape.intrusiveness.optional(),
  limits: z
    .object({ minutes: z.number().int().positive(), requests: z.number().int().positive(), costUsd: z.number().positive() })
    .optional(),
  excludedPaths: auditSchema.shape.excludedPaths.optional(),
  releaseProven: auditSchema.shape.releaseProven.optional(),
  testAccounts: z
    .array(z.union([headerAccount.extend({ headerValue: headerAccount.shape.headerValue.optional() }), loginAccount.extend({ password: loginAccount.shape.password.optional() })]))
    .max(3)
    .optional(),
});
export type AmendInput = z.infer<typeof amendSchema>;

/**
 * An edit on the plan while it is pending: the same request, amended in place (PATCH, one `gate1.amend` on the ledger),
 * named by the version the editor saw, so an edit in another tab is never overwritten (409 plan_changed).
 */
export async function amendPlanAction(requestId: string, input: AmendInput): Promise<ActionResult<AssessmentRequest>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const id = uuid.safeParse(requestId);
  const parsed = amendSchema.safeParse(input);
  if (!id.success || !parsed.success) return invalid('That change is not complete yet.');
  const { limits, ...rest } = parsed.data;
  const body = {
    ...rest,
    ...(limits === undefined
      ? {}
      : { budgetRequests: limits.requests, budgetSeconds: limits.minutes * SECONDS_PER_MINUTE, costCapUsd: limits.costUsd }),
  };
  return toResult(async () =>
    requestSchema.parse(await callApi(session, `/requests/${enc(id.data)}`, { method: 'PATCH', body })),
  );
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
  /** The plan version the approver read: a plan changed since is refused (409 plan_changed), never approved unseen. */
  version: number,
): Promise<ActionResult<{ runId: string }>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const id = uuid.safeParse(requestId);
  const why = reasonSchema.safeParse(reason);
  if (!id.success || !why.success || !Number.isInteger(version)) return invalid('Say why it is safe to run.');
  const approved = await toResult(() =>
    callApi(session, `/requests/${enc(id.data)}/decision`, {
      method: 'POST',
      body: { decision: 'approve', reason: why.data, version },
    }),
  );
  if (!approved.ok) {
    if (approved.status !== HTTP_CONFLICT || approved.code === 'plan_changed') return plainOwnership(approved);
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
    return plainOwnership(await toResult(() => Promise.reject(error instanceof Error ? error : new Error('start failed'))));
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
  return plainOwnership(started);
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

const LOGIN_PROBE_TIMEOUT_MS = 6000;
const LOGIN_PROBE_MAX_HOPS = 4;
const LOGIN_PROBE_MAX_BYTES = 200_000;

/**
 * Does the address show a login form? Asked only for a site the person has verified, so it never reaches an address
 * they do not own. Follows a few redirects (a signed-out site often sends the home page to its login page).
 */
export async function detectLoginAction(origin: string, host: string): Promise<ActionResult<{ loginForm: boolean }>> {
  const target = await ensureTargetAction(origin, host);
  if (!target.ok) return target;
  if (target.data.ownership.status !== 'verified') return { ok: true, data: { loginForm: false } };
  let url = origin;
  try {
    for (let hop = 0; hop <= LOGIN_PROBE_MAX_HOPS; hop += 1) {
      const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(LOGIN_PROBE_TIMEOUT_MS), headers: { 'user-agent': 'blackwing-order/1' } });
      const next = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && next !== null) {
        url = new URL(next, url).href;
        if (new URL(url).origin !== new URL(origin).origin) break;
        continue;
      }
      const html = (await res.text()).slice(0, LOGIN_PROBE_MAX_BYTES);
      return { ok: true, data: { loginForm: /<input\b[^>]*type\s*=\s*["']?password/i.test(html) } };
    }
  } catch {
    // Unreachable or slow: no prompt, the plan page still has the test-account editor.
  }
  return { ok: true, data: { loginForm: false } };
}
