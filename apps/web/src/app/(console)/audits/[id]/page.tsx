// The plan read-back and Gate 1 (experience spec §3.4). The request, its site and the workspace settings load in
// parallel; the page is the plan paragraph, the facts, what happens next and the approval card.
import { notFound } from 'next/navigation';
import { z } from 'zod';

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLACED = 'Replaced by an edited plan';
/** An edit creates the new plan, then retires the old one: both within a few seconds. */
const REPLACE_WINDOW_MS = 15_000;
/** Decided plans after the edit that are checked for the new one (it may since be approved, or edited again). */
const DECIDED_TO_CHECK = 4;
const ledgerSchema = z.object({
  items: z.array(z.object({ at: z.string(), action: z.string(), targetType: z.string(), targetId: z.string() })),
});

/**
 * The plan that replaced this one: same site, same person, created as this one was retired. Looked up only for a
 * replaced plan, so its page links on instead of offering a fresh start. The new plan is either still waiting
 * (/dashboard) or was decided after the edit (a Gate 1 event on the ledger: approved, or itself edited again).
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
  const [d, ledger] = await Promise.all([
    retryOnce(async () => dashboardSchema.parse(await callApi(session, '/dashboard'))).catch(() => null),
    retryOnce(async () => ledgerSchema.parse(await callApi(session, '/audit'))).catch(() => null),
  ]);
  const waiting = d?.requests.find((r) => isNext(r));
  if (waiting !== undefined) return waiting.id;
  const decidedSince = [
    ...new Set(
      (ledger?.items ?? [])
        .filter((e) => e.targetType === 'request' && e.action.startsWith('gate1.') && e.targetId !== plan.id)
        .filter((e) => Date.parse(e.at) >= decided)
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((e) => e.targetId),
    ),
  ].slice(0, DECIDED_TO_CHECK);
  for (const id of decidedSince) {
    const r = await retryOnce(async () =>
      requestSchema.parse(await callApi(session, `/requests/${encodeURIComponent(id)}`)),
    ).catch(() => null);
    if (r !== null && isNext(r)) return r.id;
  }
  return null;
}

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
