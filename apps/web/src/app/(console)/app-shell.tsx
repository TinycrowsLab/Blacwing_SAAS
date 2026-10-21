'use client';

import type { ReactNode } from 'react';

export interface AppShellProps {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly roles: readonly string[];
  /** Slot for the navigation (CONSOLE-004). */
  readonly nav?: ReactNode;
  readonly children: ReactNode;
}

/** Frame of every authenticated page: header with the signed-in user, nav slot and content. */
export function AppShell({ user, roles, nav, children }: AppShellProps): ReactNode {
  const label = user.name === '' ? user.email : user.name;
  return (
    <div className="flex min-h-screen flex-col" data-testid="app-shell">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="font-semibold">Blackwing</span>
        <div className="text-sm text-muted-foreground" data-testid="app-shell-user">
          <span>{label}</span>
          {roles.length > 0 && <span className="ml-2">({roles.join(', ')})</span>}
        </div>
      </header>
      <div className="flex flex-1">
        {nav !== undefined && <aside className="w-56 border-r border-border">{nav}</aside>}
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
