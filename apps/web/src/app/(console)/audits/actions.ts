'use server';
/* eslint-disable @typescript-eslint/no-magic-numbers -- the API's field limits (apps/api demo controller LIMITS), checked again here at the boundary */

// The order and Gate 1 (experience spec §3.3, §3.4, §10.4). Each action runs as the signed-in person, validates its
// input with zod (server actions are public endpoints), calls the API and returns an ActionResult: never a redirect, so
// the page keeps what was typed and says what to fix. Conflicts that mean "already done" are mapped to success.
import { z } from 'zod';

import { type ActionResult, ApiError, callApi, toResult } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { type Asset, assetSchema, type AssessmentRequest, requestSchema } from '../../../lib/schemas';

const enc = encodeURIComponent;
const HTTP_CONFLICT = 409;
const HTTP_UNAUTHORIZED = 401;
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

/** Registers the site (or finds it: the API reuses an asset with the same origin). */
export async function ensureTargetAction(origin: string, host: string): Promise<ActionResult<Asset>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const input = z.object({ origin: webOrigin, host: z.string().trim().min(1).max(120) }).safeParse({ origin, host });
  if (!input.success) return invalid("That doesn't look like a web address yet.");
  return toResult(async () =>
    assetSchema.parse(
      await callApi(session, '/assets', {
        method: 'POST',
        body: { name: input.data.host, baseUrl: input.data.origin },
      }),
    ),
  );
}

const verifySchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('http_token') }),
  z.object({ method: z.literal('owner_attestation'), statement: z.string().trim().min(10).max(1000) }),
]);
export type VerifyInput = z.infer<typeof verifySchema>;

/** Proves ownership by the well-known file or by attestation. "Already verified" (another tab) counts as success. */
export async function verifyTargetAction(assetId: string, verify: VerifyInput): Promise<ActionResult<Asset>> {
  const session = await getViewer();
  if (session === null) return signedOut;
  const id = uuid.safeParse(assetId);
  const body = verifySchema.safeParse(verify);
  if (!id.success || !body.success) return invalid('Pick a way to show the site is yours.');
  const result = await toResult(async () =>
    assetSchema.parse(await callApi(session, `/assets/${enc(id.data)}/verify`, { method: 'POST', body: body.data })),
  );
  if (!result.ok && result.status === HTTP_CONFLICT)
    return toResult(async () => assetSchema.parse(await callApi(session, `/assets/${enc(id.data)}`)));
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
  minutes: z.number().int().positive(),
  requests: z.number().int().positive(),
  costUsd: z.number().positive(),
  excludedPaths: z.array(z.string().startsWith('/').max(512)).max(50),
  releaseProven: z.enum(['hold', 'auto']),
  testAccounts: z.array(accountSchema).max(3),
});
export type AuditInput = z.infer<typeof auditSchema>;

async function createRequest(
  session: NonNullable<Awaited<ReturnType<typeof getViewer>>>,
  a: AuditInput,
): Promise<AssessmentRequest> {
  return requestSchema.parse(
    await callApi(session, '/requests', {
      method: 'POST',
      body: {
        assetId: a.assetId,
        objective: a.objective,
        intrusiveness: a.intrusiveness,
        budgetRequests: a.requests,
        budgetSeconds: a.minutes * SECONDS_PER_MINUTE,
        costCapUsd: a.costUsd,
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
    if (current.data.status !== 'approved')
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
