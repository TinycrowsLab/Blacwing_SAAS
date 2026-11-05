// Results (experience spec §7; prototype 05): what Claude proved, in three voices, Gate 3 per issue, what was kept back,
// every decision you made, and the report. Every number is the runner's; the headline and lede are templates.
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EmptyState, Icon } from '../../../../../components/console/design';
import { YourDecisions } from '../../../../../components/console/results/decisions';
import { IssueList, KeptBack, ReleaseAll } from '../../../../../components/console/results/issue-list';
import {
  decisions,
  findingDetailSchema,
  gate2Outcome,
  ledgerSchema,
  splitFindings,
  stopLine,
  testCases,
  type FindingDetail,
} from '../../../../../components/console/results/model';
import { ReportCard } from '../../../../../components/console/results/report-card';
import { ApiError, callApi } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';
import { resultsHeadline } from '../../../../../lib/plan-text';
import { LIVE_RUN_STATES, requestSchema, runSchema, workspaceSchema, type Run } from '../../../../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Results' };

const HTTP_NOT_FOUND = 404;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function hostOf(run: Run): string {
  const base = run.pins.asset?.baseUrl;
  if (base === undefined) return run.pins.asset?.name ?? 'your site';
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
}

export default async function ResultsPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  let run: Run;
  try {
    run = runSchema.parse(await callApi(session, `/runs/${encodeURIComponent(id)}`));
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === HTTP_NOT_FOUND) notFound();
    throw caught;
  }

  const { proven, kept } = splitFindings(run);
  const first = proven[0];
  // The side calls are optional: a failure leaves its line out (or says so) instead of failing the page.
  const [request, ledger, workspace, firstDetail] = await Promise.all([
    callApi(session, `/requests/${encodeURIComponent(run.requestId)}`)
      .then((b) => requestSchema.parse(b))
      .catch(() => null),
    callApi(session, '/audit')
      .then((b) => ledgerSchema.parse(b))
      .catch(() => null),
    callApi(session, '/workspace')
      .then((b) => workspaceSchema.parse(b))
      .catch(() => null),
    first === undefined
      ? Promise.resolve(null)
      : callApi(session, `/findings/${encodeURIComponent(first.id)}`)
          .then((b) => findingDetailSchema.parse(b))
          .catch(() => null),
  ]);

  const host = hostOf(run);
  const live = LIVE_RUN_STATES.includes(run.state);
  const stop = stopLine(run, Date.now());
  const severities = proven.map((f) => f.severity);
  const awaiting = proven.filter((f) => f.status === 'confirmed');
  const released = proven.filter((f) => f.status === 'released').length;
  const cases = testCases(run.events);
  const auto = (request?.releaseProven ?? 'auto') === 'auto';
  const rows = decisions({
    run,
    request,
    ledger: ledger?.items ?? [],
    viewerName: session.user.name,
    gate2TimeoutS: workspace?.settings.gate2TimeoutS ?? null,
  });
  const did =
    cases.total > 0
      ? `The team ran ${plural(cases.executed, 'test case', 'test cases')} and sent ${plural(run.requestsUsed, 'request', 'requests')}.`
      : `The team sent ${plural(run.requestsUsed, 'request', 'requests')}.`;
  const initial: FindingDetail[] = firstDetail === null ? [] : [firstDetail];

  return (
    <div className="grid w-full max-w-[1180px] gap-8 pb-28 md:pb-4 lg:grid-cols-[minmax(0,1fr)_330px]">
      <section className="flex min-w-0 flex-col gap-5" aria-labelledby="results-h">
        <div className="flex flex-col gap-2">
          <nav aria-label="Breadcrumb">
            <ol className="m-0 flex list-none flex-wrap items-center gap-2 p-0 text-[12.5px] text-muted-foreground">
              <li>Audits</li>
              <li aria-hidden="true">/</li>
              <li>
                <Link href={`/runs/${run.id}`} className="hover:text-foreground">
                  {host}
                </Link>
              </li>
              <li aria-hidden="true">/</li>
              <li aria-current="page">Results</li>
            </ol>
          </nav>
          <p
            className={`m-0 flex items-center gap-1.5 text-[13px] font-medium ${stop.tone === 'ok' ? 'text-ok' : stop.tone === 'bad' ? 'text-bad' : 'text-muted-foreground'}`}
          >
            <Icon name={stop.tone === 'ok' ? 'check' : stop.tone === 'bad' ? 'warn' : 'clock'} size={14} />
            {stop.text}
            {live ? (
              <Link href={`/runs/${run.id}`} className="ml-1 text-gold-ink underline-offset-2 hover:underline">
                Watch it live
              </Link>
            ) : null}
          </p>
          <h1 id="results-h" className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground sm:text-[30px] sm:leading-[38px]">
            {resultsHeadline(severities)}
          </h1>
          <p className="m-0 max-w-[68ch] text-[15px] leading-6 text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
            {proven.length > 0 ? (
              <>
                {did} Each issue below was replayed by the validator with a control.{' '}
                {auto ? 'Proven issues were released automatically, as you chose.' : 'Nothing reaches your report until you release it.'}
              </>
            ) : (
              <>
                {did} The validator could not prove any issue
                {kept.length > 0 ? `, so ${plural(kept.length, 'suspected issue is', 'suspected issues are')} kept back below.` : '.'}
              </>
            )}
          </p>
        </div>

        {proven.length === 0 ? (
          <EmptyState
            icon="shield"
            title="No issues were proven."
            body={
              live
                ? 'Claude is still testing. Proven issues appear here as soon as the validator confirms them.'
                : 'Nothing here means the validator could not reproduce an issue with a control, not that the site has none. Try a broader objective or a longer limit next time.'
            }
          />
        ) : (
          <>
            <ReleaseAll ids={awaiting.map((f) => f.id)} />
            <IssueList items={proven} initial={initial} viewerName={session.user.name} shortcuts />
          </>
        )}
        <KeptBack items={kept} viewerName={session.user.name} />
        <YourDecisions rows={rows} chain={ledger?.chain ?? null} />
      </section>

      <aside aria-label="Your report" className="min-w-0">
        <ReportCard
          runId={run.id}
          requestId={run.requestId}
          host={host}
          severities={severities}
          released={released}
          awaiting={awaiting.length}
          cases={cases}
          requests={{ used: run.requestsUsed, cap: run.budget.requests }}
          cost={{ used: run.costUsd, cap: run.budget.costUsd }}
          gate2={gate2Outcome(run.gate2)}
          webhook={workspace?.settings.webhook ?? null}
          ledgerHead={ledger?.items[0]?.hash ?? null}
        />
      </aside>
    </div>
  );
}
