import { notFound, redirect } from 'next/navigation';

import { PlanEditor } from './_components/plan-editor';
import { PUBLIC_RUN_ID } from '../../../../../../lib/run-detail';
import { getSession } from '../../../../../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * `/runs/[runId]/plan/edit`: the test-plan editor (#402). The approver's Gate 1 review stays at `/runs/[runId]/plan`.
 * A malformed run id is a 404 before anything loads; the API answers for runs the caller may not see.
 */
export default async function PlanEditorPage({
  params,
}: {
  readonly params: Promise<{ readonly runId: string }>;
}): Promise<ReactNode> {
  const { runId } = await params;
  if (!PUBLIC_RUN_ID.test(runId)) notFound();
  const session = await getSession();
  if (session === null) redirect('/login');
  return <PlanEditor runId={runId} roles={session.roles} />;
}
