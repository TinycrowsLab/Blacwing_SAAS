// The full-page Gate 2 decision (notifications and phones; prototype 06). The request's body and role come from the
// run's gate2.requested event; without it the card reads the role from the gate key.
import { notFound } from 'next/navigation';

import { PageHeader } from '../../../../../components/console/design';
import { Gate2Card } from '../../../../../components/console/gate2-view';
import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';
import { decisionTitle } from '../../../../../lib/plan-text';
import { gate2DetailSchema } from '../../../../../lib/schemas';
import { askedInRun } from '../../asked';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your decision' };

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

export default async function Gate2Page({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const { id } = await params;
  let gate2;
  try {
    gate2 = gate2DetailSchema.parse(await callApi(session, `/gate2/${encodeURIComponent(id)}`));
  } catch (caught) {
    if (
      caught instanceof ApiError &&
      (caught.status === HTTP_NOT_FOUND || caught.status === HTTP_BAD_REQUEST)
    )
      notFound();
    throw caught;
  }
  const asked = (await askedInRun(session, gate2.runId)).get(gate2.id) ?? null;
  return (
    <>
      <div className="hidden md:block">
        <PageHeader
          crumbs={[
            { label: 'Decisions', href: '/decisions' },
            { label: gate2.run?.assetName ?? 'Request during a run' },
          ]}
          title={decisionTitle(gate2.method, gate2.url)}
        />
      </div>
      <Gate2Card
        gate2={gate2}
        body={asked?.body ?? null}
        {...(asked === null ? {} : { asRole: asked.asRole })}
        variant="page"
        viewerName={session.user.name}
      />
    </>
  );
}
