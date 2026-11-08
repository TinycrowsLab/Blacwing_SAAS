/* eslint-disable @typescript-eslint/no-magic-numbers -- display truncation (hashes) */
// Finding detail (experience spec §7, bug 16): the title is the breadcrumb, and the issue reads in three voices: Claude's
// explanation (not verified), Blackwing's proof (probe, control, every replay) and Claude's fix suggestion when the run
// recorded one. Gate 3, the reproduction command and the report download sit beside it.
import { notFound } from 'next/navigation';
import { cache, type ReactNode } from 'react';

import { Card, CardHeader, Icon, SeverityChip } from '../../../../components/console/design';
import { IssueBody } from '../../../../components/console/results/issue-body';
import { IssueStatus } from '../../../../components/console/results/issue-list';
import { readApi } from '../../../../components/console/results/load';
import { LocalTime } from '../../../../components/console/results/local-time';
import {
  findingDetailSchema,
  type FindingDetail,
} from '../../../../components/console/results/model';
import { NavLink } from '../../../../components/console/results/nav-link';
import {
  FINDING_FORMATS,
  ReportDownload,
} from '../../../../components/console/results/report-download';
import { RetestCard } from '../../../../components/console/results/retest';
import { CopyButton, FindingTriage } from '../../../../components/console/results/triage';
import { ApiError } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Methods that only read; anything else may change data on the site. */
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Cached per request, so the title (metadata) and the page share one API call. */
const load = cache(async (id: string): Promise<FindingDetail | null> => {
  if (!UUID.test(id)) return null;
  try {
    return findingDetailSchema.parse(await readApi(`/findings/${encodeURIComponent(id)}`));
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === HTTP_NOT_FOUND) return null;
    throw caught;
  }
});

// Resolved before the page streams where Next allows it, so an unknown finding answers 404 with the not-found title.
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}) {
  const finding = await load((await params).id);
  if (finding === null) notFound();
  return { title: finding.title };
}

/** "127.0.0.1:3001" from the probe's URL, to say the target's address after its name. */
function hostOf(f: FindingDetail): string | null {
  const url = f.evidence.probe.request?.url;
  if (url === undefined) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The method of a curl command ("-X POST", or POST when it sends data), or null when it cannot be told. */
function methodOf(curl: string): string | null {
  const explicit = /(?:^|\s)(?:-X|--request)\s+['"]?([A-Za-z]+)/.exec(curl)?.[1];
  if (explicit !== undefined) return explicit.toUpperCase();
  if (/(?:^|\s)(?:-d|--data(?:-raw|-binary)?|--json|-F|--form)\s/.test(curl)) return 'POST';
  return /^\s*curl\s/.test(curl) ? 'GET' : null;
}

function Excerpt({
  title,
  side,
}: {
  readonly title: string;
  readonly side: FindingDetail['evidence']['probe'];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-foreground">
        {title}
        {side.response === undefined ? null : (
          <span className="font-mono text-muted-foreground"> · HTTP {side.response.status}</span>
        )}
      </span>
      <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-border bg-code p-3 font-mono text-[11.5px] leading-[18px] text-foreground">
        {side.response?.bodyExcerpt ?? 'No body recorded.'}
      </pre>
    </div>
  );
}

export default async function FindingPage({
  params,
}: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const finding = await load((await params).id);
  if (finding === null) notFound();
  const released = finding.status === 'released';
  const report = `/api/findings/${encodeURIComponent(finding.id)}/report`;
  const { replays } = finding.evidence;
  // The reproduction command repeats the probe: its method decides whether we may call it harmless.
  const method =
    finding.evidence.probe.request?.method.toUpperCase() ?? methodOf(finding.reproCurl);
  const writes = method === null || !READ_ONLY.has(method);
  const controlMethod = finding.evidence.control.request?.method.toUpperCase();
  // A retest replays without a person at Gate 2, so only a proven probe and control that read can be retested.
  const retestable =
    (finding.status === 'confirmed' || finding.status === 'released') &&
    !writes &&
    (controlMethod === undefined || READ_ONLY.has(controlMethod));
  const host = hostOf(finding);

  return (
    <article className="flex w-full max-w-[1180px] flex-col gap-5" aria-labelledby="finding-h">
      <div className="flex flex-col gap-2">
        <nav aria-label="Breadcrumb">
          <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-[12.5px] text-muted-foreground">
            <li className="shrink-0">
              <NavLink href="/findings" className="hover:text-foreground">
                Findings
              </NavLink>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="min-w-0 truncate">
              {finding.title}
            </li>
          </ol>
        </nav>
        <h1
          id="finding-h"
          className="m-0 text-[26px] font-semibold leading-[34px] tracking-[-0.01em] text-foreground"
        >
          {finding.title}
        </h1>
        {/* Spaced by gap, not by dots, so a wrapped line never starts with a separator. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted-foreground">
          <SeverityChip severity={finding.severity} />
          <IssueStatus status={finding.status} />
          {finding.assetName === null ? null : (
            <span>
              on <span className="text-foreground">{finding.assetName}</span>
              {host === null || host === finding.assetName ? null : (
                <span className="font-mono text-[12px]"> ({host})</span>
              )}
            </span>
          )}
          {finding.createdAt === undefined ? null : (
            <span>
              <LocalTime iso={finding.createdAt} style="datetime" prefix="found " />
            </span>
          )}
        </div>
        {finding.runId === undefined ? null : (
          <NavLink
            href={`/runs/${finding.runId}/results`}
            className="self-start text-[13px] font-medium text-gold-ink underline-offset-2 hover:underline"
          >
            See all results of this audit
          </NavLink>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <IssueBody finding={finding}>
              <div className="border-t border-border pt-3.5">
                <FindingTriage finding={finding} viewerName={session.user.name} />
              </div>
            </IssueBody>
          </div>

          <Card aria-labelledby="replays-h">
            <CardHeader id="replays-h" title="Every replay" meta="Blackwing · no model" />
            <ol className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {replays.length === 0 ? (
                <li className="px-4 py-3 text-[13px] text-muted-foreground">
                  The validator did not replay this one.
                </li>
              ) : (
                replays.map((r) => (
                  <li key={r.n} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <span className="w-16 shrink-0 text-muted-foreground sm:w-20">
                      Replay {r.n}
                    </span>
                    <span className="whitespace-nowrap font-mono">HTTP {r.status}</span>
                    <span
                      className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap font-medium ${r.matched ? 'text-ok' : 'text-muted-foreground'}`}
                    >
                      <Icon name={r.matched ? 'check' : 'minus'} size={13} />
                      {r.matched ? 'Showed it' : 'Did not show it'}
                    </span>
                  </li>
                ))
              )}
              {finding.replay?.control === null || finding.replay?.control === undefined ? null : (
                <li className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <span className="w-16 shrink-0 text-muted-foreground sm:w-20">Control</span>
                  <span className="whitespace-nowrap font-mono">
                    HTTP {finding.replay.control.status}
                  </span>
                  <span
                    className={`ml-auto inline-flex items-center gap-1.5 whitespace-nowrap font-medium ${finding.replay.control.matched ? 'text-muted-foreground' : 'text-ok'}`}
                  >
                    <Icon name={finding.replay.control.matched ? 'minus' : 'check'} size={13} />
                    {finding.replay.control.matched ? 'Showed it too' : 'Clean, as expected'}
                  </span>
                </li>
              )}
            </ol>
          </Card>

          <details className="group rounded-[14px] border border-border bg-card">
            <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-[14px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus">
              {/* On a phone the hint sits under the title instead of squeezing beside it. */}
              <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
                What the site answered
                <span className="text-[12px] font-normal text-muted-foreground">
                  Excerpts of the responses, from the target
                </span>
              </span>
              <Icon
                name="chevron"
                size={16}
                className="ml-auto text-muted-foreground transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="grid gap-3 border-t border-border p-4 md:grid-cols-2">
              <Excerpt title="Probe" side={finding.evidence.probe} />
              <Excerpt title="Control" side={finding.evidence.control} />
            </div>
          </details>
        </div>

        <aside aria-label="Reproduce and report" className="flex min-w-0 flex-col gap-3">
          {finding.reproCurl === '' ? null : (
            <section className="flex flex-col gap-2 rounded-[14px] border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="m-0 text-[14.5px] font-semibold text-foreground">Reproduce it</h2>
                <CopyButton text={finding.reproCurl} label="Copy" />
              </div>
              {writes ? (
                <p className="m-0 flex items-start gap-1.5 text-[12.5px] leading-5 text-warn">
                  <Icon name="warn" size={14} className="mt-[3px] shrink-0" />
                  <span>
                    {method === null ? 'This request' : `This ${method} request`} can change data on
                    the site. Run it only against a test copy you own, never in production.
                  </span>
                </p>
              ) : (
                <p className="m-0 text-[12.5px] leading-5 text-muted-foreground">
                  The same probe the validator sent. It is a {method} request: it reads and changes
                  nothing.
                </p>
              )}
              {/* Wrapped, never scrolled sideways: the whole command is readable in the narrow column. */}
              <pre className="m-0 max-h-60 overflow-y-auto whitespace-pre-wrap break-all rounded-[10px] border border-border bg-code p-3 font-mono text-[11.5px] leading-[18px] text-foreground">
                {finding.reproCurl}
              </pre>
            </section>
          )}
          {retestable ? <RetestCard finding={finding} /> : null}
          <section className="flex flex-col gap-2 rounded-[14px] border border-border bg-card p-4">
            <h2 className="m-0 text-[14.5px] font-semibold text-foreground">Report</h2>
            {released ? (
              <ReportDownload
                href={report}
                primary={false}
                formats={FINDING_FORMATS}
                sticky={false}
                note="this issue"
              />
            ) : (
              <p className="m-0 text-[12.5px] leading-5 text-muted-foreground">
                Only released issues go into a report. Release this one to download it.
              </p>
            )}
          </section>
          {finding.audit === null ? null : (
            <p className="m-0 flex items-center gap-2 px-1 text-[12px] text-muted-foreground">
              <Icon name="shield" size={13} className="text-ok" />
              <span className="font-mono">
                ledger · {finding.audit.hash.slice(0, 4)}…{finding.audit.hash.slice(-4)}
              </span>
              <NavLink
                href="/ledger#verify"
                className="ml-auto font-medium text-gold-ink hover:underline"
              >
                Verify
              </NavLink>
            </p>
          )}
        </aside>
      </div>
    </article>
  );
}
