// DEMO-STORY layout: every /demo page needs a Keycloak session (the same BFF session as the console). The demo
// banner is always visible. Demo only (the demo API must be running with BW_DEMO_MODE=1).
import { redirect } from 'next/navigation';

import { DemoBanner } from '../../components/demo/demo-banner';
import { getSession } from '../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function DemoLayout({ children }: { readonly children: ReactNode }): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) redirect('/login?returnTo=%2Fdemo');
  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <DemoBanner name={session.user.name} email={session.user.email} roles={session.roles} />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">{children}</main>
    </div>
  );
}
