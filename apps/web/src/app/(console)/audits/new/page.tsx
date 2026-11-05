// The order (experience spec §3.3): four short questions, then the plan. The targets and the workspace's suggested
// limits load here; everything after that happens on the client (steps change without a server round trip).
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { Order } from '../../../../components/console/order/order';
import { callApi } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';
import { assetSchema, workspaceSchema } from '../../../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'New audit' };

const listSchema = z.object({ items: z.array(assetSchema) });
/** The preset the order suggests (the plan offers them all). */
const SUGGESTED_PRESET = 'standard';

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
    callApi(session, '/assets')
      .then((b) => listSchema.parse(b).items)
      .catch(() => []),
    callApi(session, '/workspace')
      .then((b) => workspaceSchema.parse(b))
      .catch(() => null),
  ]);
  const presets = workspace?.settings.presets ?? [];
  const preset = presets.find((p) => p.key === SUGGESTED_PRESET) ?? presets[0];
  const step = Number(one(params.step) ?? '1');
  // Each navigation here without a draft is a new order: a fresh id remounts the client state.
  const draftId = one(params.draft) ?? randomUUID();
  return (
    <Order
      key={draftId}
      initialTarget={one(params.target)}
      initialStep={Number.isInteger(step) ? step : 1}
      draftId={draftId}
      restoreDraft={one(params.draft) !== null}
      assets={assets}
      viewerName={session.user.name}
      limits={preset === undefined ? null : { minutes: preset.minutes, requests: preset.requests, costUsd: preset.costUsd }}
    />
  );
}
