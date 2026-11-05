// Console layout: every page needs a signed-in administrator (the middleware sends everyone else to /login first).
// A workspace without a name goes to /welcome first. The sidebar is seeded here and keeps itself fresh; nothing else
// blocks the page. If the API is down the shell still renders and each page reports its own error.
import { redirect } from 'next/navigation';

import { Shell } from '../../components/console/shell';
import { callApi } from '../../lib/api';
import { getViewer } from '../../lib/auth';
import { dashboardSchema, toSidebar, workspaceSchema } from '../../lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) redirect('/login');
  const [workspace, dashboard] = await Promise.all([
    callApi(session, '/workspace')
      .then((body) => workspaceSchema.parse(body))
      .catch(() => null),
    callApi(session, '/dashboard')
      .then((body) => dashboardSchema.parse(body))
      .catch(() => null),
  ]);
  if (workspace !== null && workspace.name === null) redirect('/welcome');
  const { name, email, image } = session.user;
  return (
    <Shell
      viewer={{ name, email, image }}
      workspaceName={workspace?.name ?? dashboard?.tenant?.name ?? null}
      sidebar={dashboard === null ? null : toSidebar(dashboard)}
    >
      {children}
    </Shell>
  );
}
