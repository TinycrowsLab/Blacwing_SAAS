import { notFound, redirect } from 'next/navigation';

import { SurfaceExplorer } from './_components/surface-explorer';
import { getRun } from '../../../../../lib/run-detail.server';
import { getSession } from '../../../../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * `/runs/[runId]/surface`: the run's attack surface as an interactive graph (GRAPH-006 view). The route takes the
 * public run id, like the run detail page; the run is resolved on the server first, so an unknown, foreign or
 * unreadable run is a 404 (§8.6). The surface itself is read from the BFF on the client, so a 403 there reaches the
 * page as the permission-denied state, never as a client-side guess (§8.7).
 */
export default async function RunSurfacePage({
  params,
}: {
  readonly params: Promise<{ readonly runId: string }>;
}): Promise<ReactNode> {
  const { runId } = await params;
  const session = await getSession();
  if (session === null) redirect('/login');
  const run = await getRun(runId);
  if (run === null) notFound();
  return (
    <div className="mx-auto grid max-w-7xl gap-6">
      <header className="grid gap-1">
        <h1 className="font-mono text-xl font-semibold">Attack surface</h1>
        <p className="font-mono text-xs text-muted-foreground">{run.publicId}</p>
      </header>
      <SurfaceExplorer runId={run.id} />
    </div>
  );
}
