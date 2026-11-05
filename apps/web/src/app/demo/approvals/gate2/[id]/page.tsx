// Gate 2 decision (design 2a desktop, 2b mobile): the countdown is the interface, no decision means denied.
import { notFound } from 'next/navigation';

import { Gate2View } from '../../../../../components/demo/gate2-view';
import { getSession } from '../../../../../lib/session';
import { DemoApiError, demoApi } from '../../../_lib/demo-api';
import { gate2DetailSchema } from '../../../_lib/schemas';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

export default async function DemoGate2Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { id } = await params;
  try {
    const gate2 = gate2DetailSchema.parse(
      await demoApi(session, `/gate2/${encodeURIComponent(id)}`),
    );
    return <Gate2View gate2={gate2} />;
  } catch (caught) {
    if (caught instanceof DemoApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }
}
