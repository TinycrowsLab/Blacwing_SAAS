// What Claude asked with (the request body and the test-account role), read from the run's gate2.requested events,
// and which audit asked (target name, start time). Server only: shared by the Decisions inbox and the decision page.
import { z } from 'zod';

import { callApi } from '../../../lib/api';
import { runSchema } from '../../../lib/schemas';

import type { Viewer } from '../../../lib/auth';

export interface Asked {
  readonly body: string | null;
  readonly asRole: string | null;
}

/** The audit a request belongs to, so two identical requests from two audits never look the same. */
export interface AuditContext {
  readonly assetName: string | null;
  readonly startedAt: string;
}

export interface RunAsks {
  readonly asked: ReadonlyMap<string, Asked>;
  readonly audit: AuditContext | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids are UUIDs: anything else is answered "not found" without a call to the API. */
export const isUuid = (id: string): boolean => UUID.test(id);

const requestedSchema = z.object({
  gate2Id: z.string(),
  body: z.string().optional(),
  asRole: z.string().optional(),
});

/** Gate 2 id → what was asked, for every request in the run; empty (and no audit) when the run is not readable. */
export async function askedInRun(session: Viewer, runId: string): Promise<RunAsks> {
  const asked = new Map<string, Asked>();
  const run = runSchema.safeParse(
    await callApi(session, `/runs/${encodeURIComponent(runId)}`).catch(() => null),
  );
  if (!run.success) return { asked, audit: null };
  for (const e of run.data.events) {
    const data = e.kind === 'gate2.requested' ? requestedSchema.safeParse(e.data) : null;
    if (data?.success === true)
      asked.set(data.data.gate2Id, {
        body: data.data.body ?? null,
        asRole: data.data.asRole ?? null,
      });
  }
  return {
    asked,
    audit: {
      assetName: run.data.pins.asset?.name ?? null,
      startedAt: run.data.startedAt ?? run.data.createdAt,
    },
  };
}
