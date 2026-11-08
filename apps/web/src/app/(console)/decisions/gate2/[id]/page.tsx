// The full-page Gate 2 decision (notifications and phones; prototype 06). The heading names the audit that asks; the
// card's template question is the only question. The request's body and role come from the Gate 2 answer (older
// requests: the run's gate2.requested event); without either the card reads the role from the gate key.
import { notFound } from 'next/navigation';

import { PageHeader } from '../../../../../components/console/design';
import { Gate2Card } from '../../../../../components/console/gate2-view';
import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';
import { gate2DetailSchema } from '../../../../../lib/schemas';
import { askedInRun, askOf, isUuid } from '../../asked';

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
  // The answer says whether the viewer asked for this audit (run.viewerIsRequester), so no actor id is needed.
  const asks = await askedInRun(session, gate2, null);
  const { audit, history } = asks;
  const ask = askOf(gate2, asks);
  // Plain fallback: functions of the client card module cannot run here.
  const name = audit?.assetName ?? gate2.run?.assetName ?? 'Request during an audit';
  let path = gate2.url;
  try {
    path = new URL(gate2.url).pathname;
  } catch {
    // A bare path is shown as it is.
  }
  return (
    <div className="mx-auto w-full max-w-[1120px]">
      <div className="hidden md:block">
        <PageHeader
          crumbs={[{ label: 'Decisions', href: '/decisions' }, { label: 'Your decision' }]}
          title={
            <span className="block truncate font-mono text-[22px] tracking-normal">
              {gate2.method} {path}
            </span>
          }
        />
        <p className="m-0 mt-1 text-[13px] text-muted-foreground">{name}</p>
      </div>
      <Gate2Card
        gate2={gate2}
        body={ask.body}
        {...(ask.asRole === undefined ? {} : { asRole: ask.asRole })}
        variant="page"
        viewerName={session.user.name}
        audit={audit}
        history={history}
      />
    </div>
  );
}
