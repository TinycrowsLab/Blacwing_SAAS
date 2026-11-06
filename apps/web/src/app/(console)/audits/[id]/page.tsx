// The plan read-back and Gate 1 (experience spec §3.4). The request, its site and the workspace settings load in
// parallel; the page is the plan paragraph, the facts, what happens next and the approval card.
import { notFound } from 'next/navigation';

import { PlanView } from '../../../../components/console/order/plan-view';
import { ApiError, callApi } from '../../../../lib/api';
import { getViewer, type Viewer } from '../../../../lib/auth';
import { type AssessmentRequest, assetSchema, dashboardSchema, requestSchema } from '../../../../lib/schemas';
import { loadWorkspace, retryOnce } from '../load';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'The plan' };

const HTTP_NOT_FOUND = 404;
const REPLACED = 'Replaced by an edited plan';
/** An edit creates the new plan, then retires the old one: both within a few seconds. */
const REPLACE_WINDOW_MS = 15_000;
/** Runs started after the edit that are checked for the new plan (it may have been approved since). */
const RUNS_TO_CHECK = 3;

/**
 * The plan that replaced this one: same site, same person, created as this one was retired. Looked up only for a
 * replaced plan, so its page can link on instead of offering a fresh start.
 * shortcut: matched by time (the API keeps no link between the two). Upgrade when the API records the replacement.
 */
async function successorOf(session: Viewer, plan: AssessmentRequest): Promise<string | null> {
  if (plan.status !== 'rejected' || plan.decisionReason !== REPLACED || plan.decidedAt === null) return null;
  const decided = Date.parse(plan.decidedAt);
  const isNext = (r: AssessmentRequest): boolean =>
    r.id !== plan.id &&
    r.assetId === plan.assetId &&
    r.requester.id === plan.requester.id &&
    Math.abs(Date.parse(r.createdAt) - decided) < REPLACE_WINDOW_MS;
  const d = await retryOnce(async () => dashboardSchema.parse(await callApi(session, '/dashboard'))).catch(() => null);
  if (d === null) return null;
  const waiting = d.requests.find((r) => isNext(r));
  if (waiting !== undefined) return waiting.id;
  const later = d.runs
    .filter((r) => Date.parse(r.createdAt) >= decided)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, RUNS_TO_CHECK);
  for (const run of later) {
    const r = await retryOnce(async () =>
      requestSchema.parse(await callApi(session, `/requests/${encodeURIComponent(run.requestId)}`)),
    ).catch(() => null);
    if (r !== null && isNext(r)) return r.id;
  }
  return null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PlanPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [request, workspace] = await Promise.all([
    retryOnce(async () => requestSchema.parse(await callApi(session, `/requests/${encodeURIComponent(id)}`))).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === HTTP_NOT_FOUND) notFound();
        throw error;
      }),
    loadWorkspace(session),
  ]);
  const [asset, replacedBy] = await Promise.all([
    retryOnce(async () =>
      assetSchema.parse(await callApi(session, `/assets/${encodeURIComponent(request.assetId)}`)),
    ).catch(() => null),
    successorOf(session, request),
  ]);
  return (
    <PlanView
      key={request.id}
      request={request}
      asset={asset}
      settings={workspace?.settings ?? null}
      viewer={{ name: session.user.name, image: session.user.image }}
      replacedBy={replacedBy}
    />
  );
}
