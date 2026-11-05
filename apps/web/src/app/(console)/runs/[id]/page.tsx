// Live run (design 1a flight deck, 1b transcript). The first render is server-side; the client polls the run route.
import { notFound } from 'next/navigation';

import { RunView } from '../../../../components/console/run-view';
import { ApiError, callApi } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';
import { runSchema } from '../../../../lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

export default async function RunPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const { id } = await params;
  try {
    const run = runSchema.parse(
      await callApi(session, `/runs/${encodeURIComponent(id)}?afterSeq=0`),
    );
    return <RunView initial={run} />;
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }
}
