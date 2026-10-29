import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button } from '@blackwing/ui';

import { KillControl } from '../../../../components/kill/kill-control';
import { canTriggerKill } from '../../../../components/kill/kill-model';
import { getSession } from '../../../../lib/session';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

/**
 * `/settings/safety`: the tenant-wide kill control (F33, §8.5). Only tenant administrators see it; the
 * server re-checks every kill request regardless.
 */
export default async function SafetySettingsPage(): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) redirect('/login');
  const mayKill = canTriggerKill(session.roles, { scope: 'tenant' });
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <header className="grid gap-2">
        <h1 className="text-xl font-semibold">Safety</h1>
        <p className="text-sm text-muted-foreground">
          Stop all testing for this tenant. The egress gateway blocks first, then sandboxes end,
          model keys are revoked and workflows are cancelled.
        </p>
      </header>
      <section
        aria-labelledby="tenant-kill-title"
        className="grid gap-3 rounded-md border border-border p-4"
      >
        <h2 id="tenant-kill-title" className="text-lg font-semibold">
          Stop all tenant testing
        </h2>
        {mayKill ? (
          <KillControl scope="tenant" roles={session.roles} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Only a tenant administrator can stop all tenant testing.
          </p>
        )}
      </section>
      <Button variant="outline" asChild>
        <Link href="/settings/safety/kill-events">View kill history</Link>
      </Button>
    </div>
  );
}
