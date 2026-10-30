import { redirect } from 'next/navigation';
import * as React from 'react';

import { hasPermission } from '@blackwing/domain';
import { PermissionDenied } from '@blackwing/ui';

import { OrgSettingsForm } from '../../../../components/settings/org-settings-form';
import { getSession } from '../../../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * `/settings/org`: the organisation profile (ADMIN-001). Only a tenant administrator (`settings:read`, held by
 * `org_admin`) sees the form; the other roles get the permission-denied state and no request is sent. Writes
 * need `settings:write`, which the form mirrors as read-only; the server enforces both.
 */
export default async function OrgSettingsPage(): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) redirect('/login');
  if (!hasPermission(session.roles, 'settings:read')) {
    return <PermissionDenied permission="settings:read" />;
  }
  const canEdit = hasPermission(session.roles, 'settings:write');
  return (
    <section aria-labelledby="org-settings-title" className="grid gap-6">
      <header className="grid gap-2">
        <h1 id="org-settings-title" className="text-xl font-semibold">
          Organisation
        </h1>
        <p className="text-sm text-muted-foreground">
          The name, time zone and support contact of this organisation. The slug, data region and
          plan are set when the organisation is created.
        </p>
      </header>
      <OrgSettingsForm canEdit={canEdit} />
    </section>
  );
}
