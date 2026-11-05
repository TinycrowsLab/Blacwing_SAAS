// Console layout: every page needs a signed-in administrator (the middleware sends everyone else to /login first).
// The shell (top bar, icon rail, footer) wraps every page.
import { redirect } from 'next/navigation';

import { Shell } from '../../components/console/shell';
import { callApi } from '../../lib/api';
import { getViewer } from '../../lib/auth';
import { dashboardSchema } from '../../lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) redirect('/login');
  // The chrome (bell count, Kill target) is best effort: if the API is down the page itself reports the error.
  const dashboard = await callApi(session, '/dashboard')
    .then((body) => dashboardSchema.parse(body))
    .catch(() => null);
  const running = dashboard?.runs.find((r) => r.state === 'running' || r.state === 'paused');
  const pending = dashboard?.pendingGate2 ?? [];
  return (
    <Shell
      name={session.user.name}
      roles={session.roles}
      pendingGate2={pending.length}
      firstGate2Id={pending[0]?.id ?? null}
      runningRun={
        running === undefined
          ? null
          : { id: running.id, assetName: running.assetName ?? 'Assessment' }
      }
    >
      {children}
    </Shell>
  );
}
