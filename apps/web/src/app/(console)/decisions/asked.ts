// What Claude asked with (the request body and the test-account role), read from the run's gate2.requested events.
// Server only: shared by the Decisions inbox and the full decision page.
import { z } from 'zod';

import { callApi } from '../../../lib/api';
import { runSchema } from '../../../lib/schemas';

import type { Viewer } from '../../../lib/auth';

export interface Asked {
  readonly body: string | null;
  readonly asRole: string | null;
}

const requestedSchema = z.object({
  gate2Id: z.string(),
  body: z.string().optional(),
  asRole: z.string().optional(),
});

/** Gate 2 id → what was asked, for every request in the run; empty when the run is not readable. */
export async function askedInRun(
  session: Viewer,
  runId: string,
): Promise<ReadonlyMap<string, Asked>> {
  const asked = new Map<string, Asked>();
  const run = runSchema.safeParse(
    await callApi(session, `/runs/${encodeURIComponent(runId)}`).catch(() => null),
  );
  if (!run.success) return asked;
  for (const e of run.data.events) {
    const data = e.kind === 'gate2.requested' ? requestedSchema.safeParse(e.data) : null;
    if (data?.success === true)
      asked.set(data.data.gate2Id, {
        body: data.data.body ?? null,
        asRole: data.data.asRole ?? null,
      });
  }
  return asked;
}
