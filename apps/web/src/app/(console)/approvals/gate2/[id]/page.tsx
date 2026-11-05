// Gate 2 decision (design 2a desktop, 2b mobile): the countdown is the interface, no decision means denied.
import { notFound } from 'next/navigation';

import { Gate2View } from '../../../../../components/console/gate2-view';
import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';
import { gate2DetailSchema } from '../../../../../lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

export default async function Gate2Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const { id } = await params;
  try {
    const gate2 = gate2DetailSchema.parse(
      await callApi(session, `/gate2/${encodeURIComponent(id)}`),
    );
    return <Gate2View gate2={gate2} />;
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }
}
