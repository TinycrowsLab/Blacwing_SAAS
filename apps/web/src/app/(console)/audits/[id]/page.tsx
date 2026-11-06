// The plan read-back and Gate 1 (experience spec §3.4). The request, its site and the workspace settings load in
// parallel; the page is the plan paragraph, the facts, what happens next and the approval card.
import { notFound } from 'next/navigation';

import { PlanView } from '../../../../components/console/order/plan-view';
import { ApiError, callApi } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';
import { assetSchema, requestSchema } from '../../../../lib/schemas';
import { loadWorkspace, retryOnce } from '../load';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'The plan' };

const HTTP_NOT_FOUND = 404;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PlanPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [request, workspace] = await Promise.all([
    retryOnce(async () => requestSchema.parse(await callApi(session, `/requests/${encodeURIComponent(id)}`))).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === HTTP_NOT_FOUND) notFound();
        throw error;
      }),
    loadWorkspace(session),
  ]);
  const asset = await retryOnce(async () =>
    assetSchema.parse(await callApi(session, `/assets/${encodeURIComponent(request.assetId)}`)),
  ).catch(() => null);
  return (
    <PlanView
      key={request.id}
      request={request}
      asset={asset}
      settings={workspace?.settings ?? null}
      viewer={{ name: session.user.name, image: session.user.image }}
    />
  );
}
