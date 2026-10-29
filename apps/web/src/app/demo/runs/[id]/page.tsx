// DEMO-STORY live run timeline. The first render is server-side; the client polls the demo route for new events.
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { RunTimeline } from '../../../../components/demo/run-timeline';
import { DemoApiError, demoApi } from '../../_lib/demo-api';
import { type DemoRun, runSchema } from '../../_lib/schemas';
import { getSession } from '../../../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function DemoRunPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { id } = await params;
  let run: DemoRun;
  try {
    run = runSchema.parse(await demoApi(session, `/runs/${encodeURIComponent(id)}?afterSeq=0`));
  } catch (caught) {
    if (caught instanceof DemoApiError && caught.status === 404) notFound();
    throw caught;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Live run</h1>
        <Link className="text-sm underline" href={`/demo/requests/${run.requestId}`}>
          Back to the request
        </Link>
      </div>
      <RunTimeline runId={run.id} initial={run} />
    </div>
  );
}
