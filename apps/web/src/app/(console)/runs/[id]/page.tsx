// Watch Claude work (experience spec §5). The first render is server-side; the client polls the run route.
import Link from 'next/link';

import { buttonClass } from '../../../../components/console/design';
import { RunView } from '../../../../components/console/run-view';
import { ApiError, callApi } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';
import { runSchema } from '../../../../lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A missing or malformed run reads the same, inside the console (sidebar kept), with a way back. */
function NoSuchRun(): ReactNode {
  return (
    <section className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      <h1 className="m-0 text-[22px] font-semibold leading-8">We couldn&apos;t find that audit</h1>
      <p className="m-0 text-[14px] leading-6 text-muted-foreground">
        The link may be old, or the audit belongs to another workspace. Your audits are listed on Home.
      </p>
      <Link href="/" className={buttonClass('primary')}>
        Go to Home
      </Link>
    </section>
  );
}

export default async function RunPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const { id } = await params;
  if (!UUID.test(id)) return <NoSuchRun />;
  try {
    const run = runSchema.parse(
      await callApi(session, `/runs/${encodeURIComponent(id)}?afterSeq=0`),
    );
    return <RunView initial={run} viewerName={session.user.name} />;
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === HTTP_NOT_FOUND) return <NoSuchRun />;
    throw caught;
  }
}
