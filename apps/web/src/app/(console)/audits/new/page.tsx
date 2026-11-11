// The order (experience spec §3.3): four short questions, then the plan. The targets and the workspace's suggested
// limits load here; everything after that happens on the client (steps change without a server round trip).
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { Order } from '../../../../components/console/order/order';
import { callApi } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';
import { assetSchema } from '../../../../lib/schemas';
import { loadWorkspace, retryOnce, suggestedLimits } from '../load';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'New audit' };

const listSchema = z.object({ items: z.array(assetSchema) });

const savedDraftSchema = z.object({ step: z.number().int(), answers: z.record(z.string(), z.unknown()) });

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v !== '' ? v : null);

export default async function NewAuditPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const params = await searchParams;
  const [assets, workspace] = await Promise.all([
    retryOnce(async () => listSchema.parse(await callApi(session, '/assets')).items).catch(() => []),
    loadWorkspace(session),
  ]);
  // The draft's answers live on the server too: the bare draft link restores them in any browser.
  const draftParam = one(params.draft);
  const serverDraft =
    draftParam === null || !z.uuid().safeParse(draftParam).success
      ? null
      : await callApi(session, `/drafts/${draftParam}`)
          .then((d) => savedDraftSchema.parse(d))
          .catch(() => null);
  const step = Number(one(params.step) ?? '1');
  // Each navigation here without a draft is a new order: a fresh id remounts the client state.
  const draftId = one(params.draft) ?? randomUUID();
  return (
    <Order
      key={draftId}
      initialTarget={one(params.target) ?? (typeof serverDraft?.answers.origin === 'string' ? serverDraft.answers.origin : null)}
      initialStep={one(params.step) === null && serverDraft !== null ? serverDraft.step : Number.isInteger(step) ? step : 1}
      serverDraft={serverDraft}
      draftId={draftId}
      restoreDraft={one(params.draft) !== null}
      assets={assets}
      viewerName={session.user.name}
      limits={suggestedLimits(workspace)}
      settings={workspace?.settings ?? null}
    />
  );
}
