// The console's two shared reads, /workspace and /dashboard: the layout and the page of one render ask the API once
// for each (React cache), and a busy moment (429) is retried with a short back-off. Server only.
import { cache } from 'react';

import { dashboardSchema, workspaceSchema, type Dashboard, type Workspace } from './schemas';
import { readApi } from '../components/console/results/load';

/** The dashboard of this render. Throws when the API refuses or does not answer: each caller decides what that means. */
export const readDashboard = cache(
  async (): Promise<Dashboard> => dashboardSchema.parse(await readApi('/dashboard')),
);

/** The workspace (name and settings) of this render; throws like readDashboard. */
export const readWorkspace = cache(
  async (): Promise<Workspace> => workspaceSchema.parse(await readApi('/workspace')),
);
