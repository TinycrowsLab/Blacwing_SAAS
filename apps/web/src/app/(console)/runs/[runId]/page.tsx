import { notFound } from 'next/navigation';

import { RunDetailView } from './_components/run-detail-view';
import { getRun } from '../../../../lib/run-detail.server';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/** `/runs/[runId]`: run detail shell. Unknown, foreign or malformed ids are a 404 (CONTEXT_PACK §8.6). */
export default async function RunDetailPage({
  params,
}: {
  readonly params: Promise<{ readonly runId: string }>;
}): Promise<ReactNode> {
  const { runId } = await params;
  const run = await getRun(runId);
  if (run === null) notFound();
  // Structured log: low-cardinality route plus the public run id (no secrets in either).
  process.stdout.write(`${JSON.stringify({ route: '/runs/[runId]', runId })}\n`);
  return <RunDetailView runId={runId} initialRun={run} />;
}
