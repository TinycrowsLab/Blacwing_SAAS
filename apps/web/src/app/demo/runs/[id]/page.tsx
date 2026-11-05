// Live run (design 1a flight deck, 1b transcript). The first render is server-side; the client polls the demo route.
import { notFound } from 'next/navigation';

import { RunView } from '../../../../components/demo/run-view';
import { getSession } from '../../../../lib/session';
import { DemoApiError, demoApi } from '../../_lib/demo-api';
import { runSchema } from '../../_lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

export default async function DemoRunPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { id } = await params;
  try {
    const run = runSchema.parse(
      await demoApi(session, `/runs/${encodeURIComponent(id)}?afterSeq=0`),
    );
    return <RunView initial={run} />;
  } catch (caught) {
    if (caught instanceof DemoApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }
}
