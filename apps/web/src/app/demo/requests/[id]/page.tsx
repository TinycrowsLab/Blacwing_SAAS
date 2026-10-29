// DEMO-STORY request detail with the Gate 1 decision. The requester cannot approve their own request (separation
// of duties, refused by the API). The story signs out and signs in as the asset owner for the second approval.
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { StatusPill } from '../../../../components/demo/status-pill';
import { getSession } from '../../../../lib/session';
import { DemoApiError, demoApi } from '../../_lib/demo-api';
import { type DemoRequest, requestSchema } from '../../_lib/schemas';
import { decideRequestAction, startRunAction } from '../../actions';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;

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
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Assessment request</h1>
      {error === undefined ? null : (
        <p role="alert" className="rounded border border-red-400 bg-red-50 p-3 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
          <strong>{error}</strong>: {message ?? 'The action was refused.'}
        </p>
      )}
      <dl className="grid max-w-2xl grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt>Status</dt>
        <dd>
          <StatusPill value={request.status} />
        </dd>
        <dt>Test case</dt>
        <dd>
          <code>{request.testCaseId}</code>
        </dd>
        <dt>Intrusiveness</dt>
        <dd>{request.intrusiveness}</dd>
        <dt>Scope</dt>
        <dd>
          <code>GET {String(request.scope.host)}{String(request.scope.pathPrefix)}</code>
        </dd>
        <dt>Budget</dt>
        <dd>
          {request.budget.requests} requests, {request.budget.seconds} seconds
        </dd>
        <dt>Requested by</dt>
        <dd>{request.requester.name ?? 'unknown'}</dd>
        <dt>Approved by</dt>
        <dd>{request.approver?.name ?? 'not yet'}</dd>
      </dl>

      {request.status === 'pending_gate1' ? (
        <section className="max-w-2xl space-y-3 rounded border border-neutral-300 p-4 dark:border-neutral-700">
          <h2 className="text-lg font-semibold">Gate 1: scope approval</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            A second person must approve. The requester cannot approve their own request. To show the second approval,
            sign out and sign in as <code>owner@acme.test</code> (asset owner), then come back to this page.
          </p>
          {isRequester ? (
            <p className="text-sm">You are signed in as the requester, so approving here shows the separation-of-duties refusal.</p>
          ) : null}
          <form action={decideRequestAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="requestId" value={request.id} />
            <label className="grid gap-1 text-sm">
              Reason (optional)
              <input name="reason" maxLength={500} className="rounded border border-neutral-400 p-2 dark:bg-neutral-900" />
            </label>
            <button name="decision" value="approve" type="submit" className="rounded bg-emerald-700 px-4 py-2 text-sm text-white">
              Approve at Gate 1
            </button>
            <button name="decision" value="reject" type="submit" className="rounded border border-red-600 px-4 py-2 text-sm text-red-700 dark:text-red-300">
              Reject
            </button>
          </form>
        </section>
      ) : null}

      {request.status === 'approved' ? (
        <section className="max-w-2xl space-y-3 rounded border border-neutral-300 p-4 dark:border-neutral-700">
          <h2 className="text-lg font-semibold">Start the run</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Gate 1 is approved. The run pins the test case, the oracle, the runner version and the lab target, then probes
            the target live.
          </p>
          <form action={startRunAction}>
            <input type="hidden" name="requestId" value={request.id} />
            <button type="submit" className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
              Start run
            </button>
          </form>
        </section>
      ) : null}

      {request.runId === null ? null : (
        <p className="text-sm">
          <Link className="underline" href={`/demo/runs/${request.runId}`}>
            Open the live run timeline
          </Link>
        </p>
      )}
    </div>
  );
}
