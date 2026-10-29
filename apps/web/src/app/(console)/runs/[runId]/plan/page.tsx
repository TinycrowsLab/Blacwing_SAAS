import { notFound, redirect } from 'next/navigation';

import { Gate1Review } from './_components/gate1-review';
import { PUBLIC_RUN_ID } from '../../../../../lib/run-detail';
import { getSession } from '../../../../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * `/runs/[runId]/plan`: the Gate 1 approver review (#877). A malformed run id is a 404 before anything loads;
 * a run the caller may not see is answered by the API and shown as not available (CONTEXT_PACK §8.6).
 */
export default async function Gate1PlanPage({
  params,
}: {
  readonly params: Promise<{ readonly runId: string }>;
}): Promise<ReactNode> {
  const { runId } = await params;
  if (!PUBLIC_RUN_ID.test(runId)) notFound();
  const session = await getSession();
  if (session === null) redirect('/login');
  return <Gate1Review runId={runId} currentUserId={session.user.id} roles={session.roles} />;
}
