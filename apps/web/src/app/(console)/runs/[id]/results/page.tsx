// Results (experience spec §7; prototype 05): what Blackwing proved, in three voices, Gate 3 per issue, what was kept back,
// every decision you made, and the report. Every number is the runner's; the headline and lede are templates.
import { notFound } from 'next/navigation';
import { cache, Fragment, type ReactNode } from 'react';
import { z } from 'zod';

import { EmptyState, Icon } from '../../../../../components/console/design';
import { NotTestedList, YourDecisions } from '../../../../../components/console/results/decisions';
import { ExecutiveSummary } from '../../../../../components/console/results/executive-summary';
import { ExternalExposure } from '../../../../../components/console/results/external-exposure';
import {
  IssueList,
  KeptBack,
  ReleaseAll,
} from '../../../../../components/console/results/issue-list';
import { LiveRefresh } from '../../../../../components/console/results/live-refresh';
import { readApi } from '../../../../../components/console/results/load';
import {
  decisions,
  findingDetailSchema,
  gate2Outcome,
  headline,
  ledgerSchema,
  notTested,
  splitFindings,
  stopLine,
  testCases,
  type FindingDetail,
} from '../../../../../components/console/results/model';
import { NavLink } from '../../../../../components/console/results/nav-link';
import { ReportCard } from '../../../../../components/console/results/report-card';
import { ApiError } from '../../../../../lib/api';
import { getViewer } from '../../../../../lib/auth';
import {
  LIVE_RUN_STATES,
  requestSchema,
  runSchema,
  workspaceSchema,
  type Run,
} from '../../../../../lib/schemas';

import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;
const SUMMARY_WAIT_MS = 150_000;
const releaseModeSchema = z.object({ releaseProven: z.enum(['hold', 'auto']) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The run, or null when there is no such run (the page and its title share one API call per request). */
const loadRun = cache(async (id: string): Promise<Run | null> => {
  if (!UUID.test(id)) return null;
  try {
    return runSchema.parse(await readApi(`/runs/${encodeURIComponent(id)}`));
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === HTTP_NOT_FOUND) return null;
    throw caught;
  }
});

// The title is resolved before the page streams, so an unknown run is a real 404, not a 200 with a not-found body.
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<Metadata> {
  const run = await loadRun((await params).id);
  if (run === null) notFound();
  return { title: `Results · ${run.pins.asset?.name ?? 'Audit'}` };
}

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
  // The workspace-wide reads do not depend on the run: they start with it instead of after it.
  const ledgerRead = readApi('/audit')
    .then((b) => ledgerSchema.parse(b))
    .catch(() => null);
  const workspaceRead = readApi('/workspace')
    .then((b) => workspaceSchema.parse(b))
    .catch(() => null);
  const run = await loadRun((await params).id);
  if (run === null) notFound();

  const { proven, kept } = splitFindings(run);
  // The issue that opens is the first one still awaiting your release (else the most severe), so the decision is in view.
  const first = proven.find((f) => f.status === 'confirmed') ?? proven[0];
  // The side calls are optional: a failure leaves its line out (or says so) instead of failing the page.
  const [rawRequest, ledger, workspace, firstDetail] = await Promise.all([
    readApi(`/requests/${encodeURIComponent(run.requestId)}`).catch(() => null),
    ledgerRead,
    workspaceRead,
    first === undefined
      ? Promise.resolve(null)
      : readApi(`/findings/${encodeURIComponent(first.id)}`)
          .then((b) => findingDetailSchema.parse(b))
          .catch(() => null),
  ]);

  const host = hostOf(run);
  const name = run.pins.asset?.name ?? host;
  const live = LIVE_RUN_STATES.includes(run.state);
  const cases = testCases(run.events, run.coverage);
  const stop = stopLine(run, Date.now(), cases);
  // The summary is written after the run is marked finished: keep refreshing for a couple of minutes to pick it up.
  const summaryPending =
    !live && run.state === 'completed' && run.executiveSummary === null && run.finishedAt !== null && Date.now() - Date.parse(run.finishedAt) < SUMMARY_WAIT_MS;
  // The report card counts every proven issue, as the headline does, and says how many were dismissed.
  const severities = proven.map((f) => f.severity);
  const dismissed = proven.filter((f) => f.status === 'dismissed').length;
  const awaiting = proven.filter((f) => f.status === 'confirmed');
  const released = proven.filter((f) => f.status === 'released').length;
  const allDecided = !live && proven.length > 0 && awaiting.length === 0;
  const request = requestSchema.safeParse(rawRequest).data ?? null;
  // Read from the raw answer: the schema defaults a missing mode, and an unknown mode says nothing rather than guess.
  const releaseMode = releaseModeSchema.safeParse(rawRequest).data?.releaseProven ?? null;
  const rows = decisions({
    run,
    request,
    ledger: ledger?.items ?? [],
    viewerName: session.user.name,
    gate2TimeoutS: workspace?.settings.gate2TimeoutS ?? null,
  });
  const ran =
    cases.executed < cases.total
      ? `${cases.executed.toLocaleString()} of ${plural(cases.total, 'planned test case', 'planned test cases')}`
      : plural(cases.executed, 'test case', 'test cases');
  const did =
    cases.total > 0
      ? `The team ran ${ran} and sent ${plural(run.requestsUsed, 'request', 'requests')}.`
      : `The team sent ${plural(run.requestsUsed, 'request', 'requests')}.`;
  const initial: FindingDetail[] = firstDetail === null ? [] : [firstDetail];
  const gaps = notTested({
    coverage: run.coverage,
    endReason: run.coverage?.endReason ?? null,
    excludedPaths: request?.excludedPaths ?? [],
    summary: run.summary,
  });
  const untried = run.coverage?.cases.filter((c) => c.status === 'not_run' || c.status === 'blocked').length ?? 0;

  return (
    <div className="mx-auto grid w-full max-w-[1180px] gap-8 pb-28 md:pb-4 lg:grid-cols-[minmax(0,1fr)_330px]">
      <section className="flex min-w-0 flex-col gap-5" aria-labelledby="results-h">
        <div className="flex flex-col gap-2">
          <nav aria-label="Breadcrumb">
            <ol className="m-0 flex list-none flex-wrap items-center gap-2 p-0 text-[12.5px] text-muted-foreground">
              <li>
                <NavLink href="/" className="hover:text-foreground">
                  Home
                </NavLink>
              </li>
              <li aria-hidden="true">/</li>
              <li className="min-w-0 truncate">
                <NavLink href={`/runs/${run.id}`} className="hover:text-foreground" title={host}>
                  {name}
                </NavLink>
              </li>
              <li aria-hidden="true">/</li>
              <li aria-current="page">Results</li>
            </ol>
          </nav>
          <p
            className={`m-0 flex items-center gap-1.5 text-[13px] font-medium ${stop.tone === 'ok' ? 'text-ok' : stop.tone === 'bad' ? 'text-bad' : stop.tone === 'warn' ? 'text-warn' : 'text-muted-foreground'}`}
          >
            <Icon
              name={stop.tone === 'ok' ? 'check' : stop.tone === 'bad' || stop.tone === 'warn' ? 'warn' : 'clock'}
              size={14}
              className="shrink-0"
            />
            {stop.text}
            {live ? (
              <NavLink
                href={`/runs/${run.id}`}
                className="ml-1 text-gold-ink underline-offset-2 hover:underline"
              >
                Watch it live
              </NavLink>
            ) : null}
          </p>
          <h1
            id="results-h"
            className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground sm:text-[30px] sm:leading-[38px]"
          >
            {/* Each sentence is one unit: when the line is full it breaks between them, never inside the first. */}
            {(live
              ? proven.length === 0
                ? 'Blackwing is still testing. Nothing is proven yet.'
                : `Blackwing has proved ${plural(proven.length, 'issue', 'issues')} so far.`
              : headline(proven)
            )
              .split(/(?<=\.) /)
              .map((sentence, i) => (
                <Fragment key={i}>
                  {i === 0 ? null : ' '}
                  <span className="inline-block">{sentence}</span>
                </Fragment>
              ))}
          </h1>
          <p className="m-0 text-[15px] leading-6 text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
            {proven.length > 0 ? (
              <>
                {did} Each issue below was replayed by the validator.
                {releaseMode === 'auto'
                  ? ' Proven issues were released automatically, as you chose on the plan.'
                  : allDecided || releaseMode === null
                    ? null
                    : ' Nothing reaches your report until you release it.'}
              </>
            ) : (
              <>
                {did} The validator{' '}
                {live ? 'has not proved any issue yet' : 'could not prove any issue'}
                {kept.length > 0
                  ? `, so ${plural(kept.length, 'suspected issue is', 'suspected issues are')} kept back below.`
                  : '.'}
                {live ? ' This page updates on its own.' : null}
              </>
            )}
          </p>
          {allDecided ? (
            <p className="m-0 flex items-center gap-1.5 text-[14px] font-medium text-ok">
              <Icon name="check" size={15} />
              Review complete · report ready.
              {kept.length > 0
                ? ` ${plural(kept.length, 'kept-back issue is', 'kept-back issues are')} not proven and stay out of the report.`
                : ''}
            </p>
          ) : null}
        </div>

        <ExecutiveSummary markdown={run.executiveSummary?.markdown ?? null} />
        {proven.length === 0 ? (
          <EmptyState
            icon="shield"
            title={live ? 'Nothing to release yet.' : 'Nothing to release.'}
            body={
              live
                ? 'Blackwing is still testing. Proven issues appear here as soon as the validator confirms them.'
                : 'Nothing here means the validator could not reproduce an issue with a control, not that the site has none. Try a broader objective or a longer limit next time.'
            }
          />
        ) : (
          <>
            <ReleaseAll ids={awaiting.map((f) => f.id)} runId={run.id} />
            <IssueList
              items={proven}
              initial={initial}
              openId={first?.id}
              viewerName={session.user.name}
              shortcuts
            />
          </>
        )}
        <KeptBack items={kept} viewerName={session.user.name} />
        <ExternalExposure intel={run.intel} />
        {live || !gaps.recorded ? null : <NotTestedList data={gaps} />}
        <YourDecisions rows={rows} chain={ledger?.chain ?? null} />
      </section>

      <aside aria-label="Your report" className="min-w-0">
        <ReportCard
          runId={run.id}
          requestId={run.requestId}
          name={name}
          host={host}
          severities={severities}
          dismissed={dismissed}
          released={released}
          awaiting={awaiting.length}
          live={live}
          cases={cases}
          requests={{ used: run.requestsUsed, cap: run.budget.requests }}
          cost={{ used: run.costUsd, cap: run.budget.costUsd }}
          gate2={gate2Outcome(run.gate2)}
          webhook={workspace?.settings.webhook ?? null}
          ledgerHead={ledger?.items[0]?.hash ?? null}
          untried={live ? 0 : untried}
        />
      </aside>
      {live || summaryPending ? <LiveRefresh /> : null}
    </div>
  );
}
