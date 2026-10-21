import { redirect } from 'next/navigation';

import { AppShell } from './app-shell';
import { getSession } from '../../lib/session';

import type { ReactNode } from 'react';

// Every navigation re-validates the session; nothing here may be statically cached.
export const dynamic = 'force-dynamic';

/**
 * Server Component: the redirect happens before any protected markup is produced, so there is no
 * flash of protected content. Only `user` and `roles` cross into the client shell, never tokens.
 */
export default async function ConsoleLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) redirect('/login');
  return (
    <AppShell user={session.user} roles={session.roles}>
      {children}
    </AppShell>
  );
}
