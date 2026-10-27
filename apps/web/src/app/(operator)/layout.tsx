import { redirect } from 'next/navigation';

import { getSession } from '../../lib/session';

import type { ReactNode } from 'react';

// Every navigation re-validates the session; nothing here may be statically cached.
export const dynamic = 'force-dynamic';

/**
 * The operator console frame. It only requires a signed-in session: whether the caller is a platform
 * operator is decided by the operator API on every call (403 `NOT_OPERATOR`), never by the client.
 */
export default async function OperatorLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) redirect('/login');
  return (
    <div className="flex min-h-screen flex-col" data-testid="operator-shell">
      <header className="border-b border-border px-4 py-3 font-semibold">Blackwing operator</header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
