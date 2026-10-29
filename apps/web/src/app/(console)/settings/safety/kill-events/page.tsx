import { KillHistoryTable } from '../../../../../components/kill/kill-history-table';

import type { ReactNode } from 'react';

/** `/settings/safety/kill-events`: the tenant's kill history (scope, actor, status, halt time). */
export default function KillEventsPage(): ReactNode {
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <header className="grid gap-2">
        <h1 className="text-xl font-semibold">Kill history</h1>
        <p className="text-sm text-muted-foreground">
          Every kill this tenant has triggered, newest first, with the halt time the server
          measured.
        </p>
      </header>
      <KillHistoryTable />
    </div>
  );
}
