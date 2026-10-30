// DEMO-STORY request detail with the Gate 1 decision. The requester cannot approve their own request (separation
// of duties, refused by the API). The story signs out and signs in as the asset owner for the second approval.
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  Card,
  CardHeader,
  Chip,
  Icon,
  INPUT_CLASS,
  IdChip,
  LinkButton,
  PageHeader,
  StatusChip,
  buttonClass,
} from '../../../../components/demo/design';
import { ContextPanel } from '../../../../components/demo/shell';
import { getSession } from '../../../../lib/session';
import { DemoApiError, demoApi } from '../../_lib/demo-api';
import { type DemoRequest, requestSchema } from '../../_lib/schemas';
import { decideRequestAction, startRunAction } from '../../actions';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

function intrusivenessChip(value: string): ReactNode {
  const v = value.toLowerCase();
  if (v.includes('passive'))
    return (
      <Chip tone="info" icon="eye" pill>
        Passive
      </Chip>
    );
  if (v.includes('active'))
    return (
      <Chip tone="primary" icon="probe" pill>
        Active-safe
      </Chip>
    );
  if (v.includes('state'))
    return (
      <Chip tone="warn" icon="warn" pill>
        State-changing
      </Chip>
    );
  return (
    <Chip tone="muted" icon="lock" pill>
      {value}
    </Chip>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-3.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-[13px] font-medium">{children}</span>
    </div>
  );
}

export default async function DemoRequestPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getSession();
  if (session === null) return null;
  const { id } = await params;
  const query = await searchParams;
  const error = typeof query.error === 'string' ? query.error : undefined;
  const message = typeof query.message === 'string' ? query.message : undefined;
  let request: DemoRequest;
  try {
    request = requestSchema.parse(await demoApi(session, `/requests/${encodeURIComponent(id)}`));
  } catch (caught) {
    if (caught instanceof DemoApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }
  const isRequester = request.viewerIsRequester;
  const pending = request.status === 'pending_gate1';
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Approvals', href: '/demo' }, { label: 'Gate 1' }, { label: request.id }]}
        title={request.testCaseId}
        chips={<StatusChip value={request.status} />}
      />

      {error === undefined ? null : (
        <p
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-bad bg-bad-soft p-4 text-[13.5px] text-bad"
        >
          <Icon name="x" size={18} />
          <span>
            <strong className="font-semibold">{error}</strong>:{' '}
            {message ?? 'The action was refused.'}
          </span>
        </p>
      )}

      {pending ? (
        <div className="flex items-center gap-3.5 rounded-xl border border-warn bg-warn-soft px-4 py-3">
          <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
            <span className="absolute inset-0 rounded-full bg-warn motion-safe:animate-ping" />
            <span className="absolute inset-0 rounded-full bg-warn" />
          </span>
          <span className="flex-1 text-[13.5px]">
            <strong className="font-semibold">Gate 1: scope approval needed.</strong> The test plan
            does not run until a second person approves it. No decision means nothing runs.
          </span>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card aria-labelledby="scope-h">
            <CardHeader id="scope-h" title="Scope and budget" />
            <div className="grid gap-3 p-4 md:grid-cols-3">
              <Fact label="Intrusiveness">{intrusivenessChip(request.intrusiveness)}</Fact>
              <Fact label="Environment">
                <span className="inline-flex h-6 items-center rounded-md border border-bad px-2.5 font-medium text-bad">
                  Lab target
                </span>
              </Fact>
              <Fact label="Budget">
                <span className="font-mono">{request.budget.requests}</span> requests,{' '}
                <span className="font-mono">{request.budget.seconds}</span> s
              </Fact>
            </div>
            <div className="border-t border-border px-4 py-3">
              <span className="text-xs text-muted-foreground">Scope</span>
              <div className="mt-1 font-mono text-[13px]">
                GET {String(request.scope.host)}
                {String(request.scope.pathPrefix)}
              </div>
            </div>
          </Card>

          <Card aria-labelledby="people-h">
            <CardHeader id="people-h" title="Who decides" />
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-3 p-4 text-[13px]">
              <dt className="text-muted-foreground">Requested by</dt>
              <dd>{request.requester.name ?? 'unknown'}</dd>
              <dt className="text-muted-foreground">Approved by</dt>
              <dd>{request.approver?.name ?? 'not yet'}</dd>
              <dt className="text-muted-foreground">Decision reason</dt>
              <dd>{request.decisionReason ?? 'none'}</dd>
            </dl>
          </Card>

          {pending ? (
            <Card aria-labelledby="decide-h">
              <CardHeader
                id="decide-h"
                title="Gate 1 decision"
                meta="Recorded in the audit ledger"
              />
              <form action={decideRequestAction} className="flex flex-col gap-4 p-4">
                <input type="hidden" name="requestId" value={request.id} />
                {isRequester ? (
                  <p className="flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-[13px] text-muted-foreground">
                    <Icon name="lock" size={15} className="mt-0.5" />
                    You requested this plan, so a different person has to approve it. Switch to the
                    asset owner to approve. The API refuses a self-approval if this check is
                    bypassed.
                  </p>
                ) : null}
                <label className="flex flex-col gap-1.5 text-[12.5px] font-medium">
                  Reason{' '}
                  <span className="font-normal text-muted-foreground">
                    (optional for deny, recommended for approve)
                  </span>
                  <input
                    name="reason"
                    maxLength={500}
                    placeholder="Why this is safe to allow"
                    className={INPUT_CLASS}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    name="decision"
                    value="reject"
                    type="submit"
                    className={buttonClass('deny', 'h-12 px-8 text-[14.5px] font-semibold')}
                  >
                    <Icon name="x" size={16} />
                    Deny
                  </button>
                  <button
                    name="decision"
                    value="approve"
                    type="submit"
                    disabled={isRequester}
                    title={
                      isRequester
                        ? 'You requested this plan. Asset Owners can approve it.'
                        : undefined
                    }
                    className={buttonClass('secondary', 'h-12 px-5 text-[14px]')}
                  >
                    Approve at Gate 1
                  </button>
                  <span className="ml-auto text-xs text-muted-foreground">
                    No decision means deny
                  </span>
                </div>
              </form>
            </Card>
          ) : null}

          {request.status === 'approved' ? (
            <Card aria-labelledby="start-h">
              <CardHeader id="start-h" title="Start the run" />
              <div className="flex flex-col gap-4 p-4">
                <p className="text-[13.5px] leading-6 text-muted-foreground">
                  Gate 1 is approved. The run pins the test case, the oracle, the runner version and
                  the lab target, then probes the target live.
                </p>
                <form action={startRunAction}>
                  <input type="hidden" name="requestId" value={request.id} />
                  <button type="submit" className={buttonClass('primary', 'h-11 px-5')}>
                    Start run
                  </button>
                </form>
              </div>
            </Card>
          ) : null}

          {request.runId === null ? null : (
            <div className="flex items-center gap-3">
              <IdChip>{request.runId}</IdChip>
              <LinkButton href={`/demo/runs/${request.runId}`} variant="primary">
                Open the live run
              </LinkButton>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <ContextPanel
            sections={[
              {
                title: 'Who sees it',
                body: 'The requester sees the request. The asset owner decides at Gate 1. Auditors see the ledger version.',
              },
              {
                title: 'Why Deny is dark',
                body: 'Deny gets the heaviest button but not red, because red is reserved for Kill. Approve is the lighter, outlined option.',
              },
              {
                title: 'Audited',
                body: 'Every Gate 1 decision, with the reason and the signer.',
              },
            ]}
          />
          <Link href="/demo/requests/new" className="text-[12.5px] text-primary hover:underline">
            Create another request
          </Link>
        </div>
      </div>
    </div>
  );
}
