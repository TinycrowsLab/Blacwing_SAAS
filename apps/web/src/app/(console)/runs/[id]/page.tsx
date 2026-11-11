// Watch Blackwing work (experience spec §5). The first render is server-side; the client polls the run route. When the
// API is busy (429) or slow at that moment, the page still opens and the client loader keeps trying: a person who just
// approved an audit never lands on an error page while it runs.
import Link from 'next/link';
import { cache, type ReactNode } from 'react';

import { buttonClass } from '../../../../components/console/design';
import { RunView, RunViewLoader } from '../../../../components/console/run-view';
import { ApiError, callApi } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';
import { runSchema } from '../../../../lib/schemas';

import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One read per request, shared by the title and the page. */
const loadRun = cache(async (id: string) => {
  const session = await getViewer();
  if (session === null) return null;
  return runSchema.parse(await callApi(session, `/runs/${encodeURIComponent(id)}?afterSeq=0`));
});

/** "127.0.0.1:3082 | Blackwing": the target's host, like the run header. A run that cannot be read keeps the default. */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!UUID.test(id)) return {};
  const run = await loadRun(id).catch(() => null);
  const base = run?.pins.asset?.baseUrl;
  if (base === undefined) return run?.pins.asset?.name === undefined ? {} : { title: run.pins.asset.name };
  try {
    return { title: new URL(base).host };
  } catch {
    return { title: base };
  }
}

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
    const run = await loadRun(id);
    if (run === null) return null;
    return <RunView initial={run} viewerName={session.user.name} />;
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === HTTP_NOT_FOUND) return <NoSuchRun />;
    // Transient (rate limited, timed out, 5xx): the client loads it with back-off instead of an error page.
    return <RunViewLoader id={id} viewerName={session.user.name} />;
  }
}
