// Which audit asked (target name, start time, whose audit it is), what Claude asked with (the request body and the
// test-account role) and the audit's other Gate 2 requests (so a second ask says what was decided before). The Gate 2
// answer carries the asker's details itself; the run's gate2.requested events are the fallback for older requests.
// An owner that could not be read is said to be unknown, never guessed. Server only: shared by the Decisions inbox and
// the decision page.
import { z } from 'zod';

import { callApi } from '../../../lib/api';
import { objectivePhrase } from '../../../lib/plan-text';
import { LIVE_RUN_STATES, requestSchema, runSchema, type Gate2 } from '../../../lib/schemas';

import type { AuditContext } from '../../../components/console/gate2-view';
import type { Viewer } from '../../../lib/auth';

interface Asked {
  readonly body: string | null;
  readonly asRole: string | null;
}

export interface RunAsks {
  readonly asked: ReadonlyMap<string, Asked>;
  readonly audit: AuditContext | null;
  readonly history: readonly Gate2[];
  /** False when a read failed (the page shows what it has and reads again on its next refresh). */
  readonly complete: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids are UUIDs: anything else is answered "not found" without a call to the API. */
export const isUuid = (id: string): boolean => UUID.test(id);

const requestedSchema = z.object({
  gate2Id: z.string(),
  body: z.string().optional(),
  asRole: z.string().optional(),
});

interface Owner {
  /** The requester's name ("a teammate" when the person has none). */
  readonly name: string;
  readonly mine: boolean;
}

/**
 * Whose audit asked, from the Gate 2 answer itself: null when it does not say (an older API), or when it cannot be told
 * whether the viewer is that person. `actorId` is the viewer's id as the API knows it (the dashboard's actor).
 */
export function ownerOf(gate2: Gate2, actorId: string | null): Owner | null {
  if (gate2.requester === null) return null;
  const mine = gate2.run?.viewerIsRequester ?? (actorId === null ? undefined : gate2.requester.id === actorId);
  return mine === undefined ? null : { name: gate2.requester.name ?? 'a teammate', mine };
}

/** Body and role as asked: the Gate 2 answer's own when it has them, else the run's event; undefined role = unknown. */
export function askOf(gate2: Gate2, asks: RunAsks | undefined): { body: string | null; asRole: string | null | undefined } {
  if (gate2.body !== null) return { body: gate2.body, asRole: gate2.asRole };
  const a = asks?.asked.get(gate2.id);
  return { body: a?.body ?? null, asRole: a === undefined ? (gate2.asRole ?? undefined) : a.asRole };
}

/** What the run says about `gate2`'s audit; the Gate 2 answer fills in what the run could not be read for. */
export async function askedInRun(session: Viewer, gate2: Gate2, actorId: string | null): Promise<RunAsks> {
  const asked = new Map<string, Asked>();
  const owner = ownerOf(gate2, actorId);
  const run = runSchema.safeParse(
    await callApi(session, `/runs/${encodeURIComponent(gate2.runId)}`).catch(() => null),
  );
  const pinned = run.success ? (run.data.pins.request?.objective ?? '') : '';
  // The request is read only for what neither the Gate 2 answer nor the run's pins carry.
  const request =
    run.success && (owner === null || pinned === '')
      ? requestSchema.safeParse(
          await callApi(session, `/requests/${encodeURIComponent(run.data.requestId)}`).catch(() => null),
        )
      : null;
  if (run.success)
    for (const e of run.data.events) {
      const data = e.kind === 'gate2.requested' ? requestedSchema.safeParse(e.data) : null;
      if (data?.success === true)
        asked.set(data.data.gate2Id, { body: data.data.body ?? null, asRole: data.data.asRole ?? null });
    }
  const startedAt = gate2.runStartedAt ?? (run.success ? (run.data.startedAt ?? run.data.createdAt) : null);
  const requested = request?.success === true ? request.data : null;
  const objective = pinned !== '' ? pinned : (requested?.objective ?? '');
  const who: Owner | null =
    owner ??
    (requested === null
      ? null
      : { name: requested.requester.name ?? 'a teammate', mine: requested.viewerIsRequester });
  return {
    asked,
    audit:
      startedAt === null
        ? null
        : {
            assetName: gate2.assetName ?? (run.success ? (run.data.pins.asset?.name ?? null) : null),
            startedAt,
            requester: who?.name ?? null,
            mine: who?.mine ?? false,
            objective: objective === '' ? null : objectivePhrase(objective),
            // A request still waiting means the audit is live, whatever the run read said.
            live: run.success ? LIVE_RUN_STATES.includes(run.data.state) : gate2.status === 'pending',
          },
    history: run.success ? run.data.gate2 : [],
    complete: run.success && who !== null,
  };
}
