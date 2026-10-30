import { redirect } from 'next/navigation';
import * as React from 'react';

import { PermissionDenied } from '@blackwing/ui';

import { SettingsNav } from '../../../components/settings/settings-nav';
import { getSession } from '../../../lib/session';
import { visibleSettingsEntries } from '../../../lib/settings-nav';

import type { ReactNode } from 'react';

// Every navigation re-validates the session; nothing here may be statically cached.
export const dynamic = 'force-dynamic';

/**
 * The tenant Settings section (ADMIN-001): a left sub-nav over every settings page. A member who may open no
 * settings section sees the shared permission-denied state and no content; the pages check their own
 * permission again.
 */
export default async function SettingsLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) redirect('/login');
  const entries = visibleSettingsEntries(session.roles);
  if (entries.length === 0) return <PermissionDenied permission="settings:read" />;
  return (
    <div className="mx-auto grid max-w-5xl gap-6 md:grid-cols-[12rem_minmax(0,1fr)]">
      <aside aria-label="Settings" className="min-w-0">
        <SettingsNav entries={entries} />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
