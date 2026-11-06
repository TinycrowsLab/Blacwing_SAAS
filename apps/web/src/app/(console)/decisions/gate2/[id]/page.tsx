// The full-page Gate 2 decision (notifications and phones; prototype 06). The heading names the audit that asks; the
// card's template question is the only question. The request's body and role come from the run's gate2.requested
// event; without it the card reads the role from the gate key.
import { notFound } from 'next/navigation';

import { PageHeader } from '../../../../../components/console/design';
import { Gate2Card } from '../../../../../components/console/gate2-view';
import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';
import { gate2DetailSchema } from '../../../../../lib/schemas';
import { askedInRun, isUuid } from '../../asked';

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
  const { id } = await params;
  // shortcut: notFound() here renders the not-found page with HTTP 200, because the console's loading boundary has
  // already streamed; a 404 status needs the check in middleware.
  if (!isUuid(id)) notFound();
  const session = await getViewer();
  if (session === null) return null;
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
  const { asked, audit, history } = await askedInRun(session, gate2.runId);
  const ask = asked.get(gate2.id) ?? null;
  // Plain fallback: functions of the client card module cannot run here.
  const name = audit?.assetName ?? gate2.run?.assetName ?? 'Request during an audit';
  return (
    <>
      <div className="hidden md:block">
        <PageHeader
          crumbs={[{ label: 'Decisions', href: '/decisions' }, { label: 'Your decision' }]}
          title={name}
        />
      </div>
      <Gate2Card
        gate2={gate2}
        body={ask?.body ?? null}
        {...(ask === null ? {} : { asRole: ask.asRole })}
        variant="page"
        viewerName={session.user.name}
        audit={audit}
        history={history}
      />
    </>
  );
}
