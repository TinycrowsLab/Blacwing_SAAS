// DEMO-STORY layout: every /demo page needs a Keycloak session (the same BFF session as the console). The demo
// shell (top bar, icon rail, footer) wraps every page. Demo only (the demo API must be running with BW_DEMO_MODE=1).
import { redirect } from 'next/navigation';

import { demoApi } from './_lib/demo-api';
import { dashboardSchema } from './_lib/schemas';
import { DemoShell } from '../../components/demo/shell';
import { getSession } from '../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function DemoLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) redirect('/login?returnTo=%2Fdemo');
  // The chrome (bell count, Kill target) is best effort: if the API is down the page itself reports the error.
  const dashboard = await demoApi(session, '/dashboard')
    .then((body) => dashboardSchema.parse(body))
    .catch(() => null);
  const running = dashboard?.runs.find((r) => r.state === 'running' || r.state === 'paused');
  const pending = dashboard?.pendingGate2 ?? [];
  return (
    <DemoShell
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
    </DemoShell>
  );
}
