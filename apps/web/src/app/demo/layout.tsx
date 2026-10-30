// DEMO-STORY layout: every /demo page needs a Keycloak session (the same BFF session as the console). The demo
// shell (top bar, icon rail, footer) wraps every page. Demo only (the demo API must be running with BW_DEMO_MODE=1).
import { redirect } from 'next/navigation';

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
  return (
    <DemoShell name={session.user.name} roles={session.roles}>
      {children}
    </DemoShell>
  );
}
