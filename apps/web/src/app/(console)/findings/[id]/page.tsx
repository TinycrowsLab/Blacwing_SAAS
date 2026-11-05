/* eslint-disable @typescript-eslint/no-magic-numbers -- display truncation (hashes) */
// Finding detail (experience spec §7, bug 16): the title is the breadcrumb, and the issue reads in three voices: Claude's
// explanation (not verified), Blackwing's proof (probe, control, every replay) and Claude's fix suggestion when the run
// recorded one. Gate 3, the reproduction command and the report download sit beside it.
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Card, CardHeader, Icon, LinkButton, SeverityChip } from '../../../../components/console/design';
import { CopyField } from '../../../../components/console/design-client';
import { IssueBody } from '../../../../components/console/results/issue-body';
import { IssueStatus } from '../../../../components/console/results/issue-list';
import { LocalTime } from '../../../../components/console/results/local-time';
import { findingDetailSchema, type FindingDetail } from '../../../../components/console/results/model';
import { FindingTriage } from '../../../../components/console/results/triage';
import { ApiError, callApi } from '../../../../lib/api';
import { getViewer } from '../../../../lib/auth';

import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';

const HTTP_NOT_FOUND = 404;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function load(id: string): Promise<FindingDetail | null> {
  const session = await getViewer();
  if (session === null || !UUID.test(id)) return null;
  try {
    return findingDetailSchema.parse(await callApi(session, `/findings/${encodeURIComponent(id)}`));
  } catch (caught) {
    if (caught instanceof ApiError && caught.status === HTTP_NOT_FOUND) return null;
    throw caught;
  }
}

export async function generateMetadata({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const finding = await load((await params).id).catch(() => null);
  return { title: finding?.title ?? 'Finding' };
}

function Excerpt({ title, side }: { readonly title: string; readonly side: FindingDetail['evidence']['probe'] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-foreground">
        {title}
        {side.response === undefined ? null : <span className="font-mono text-muted-foreground"> · HTTP {side.response.status}</span>}
      </span>
      <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-[10px] border border-border bg-code p-3 font-mono text-[11.5px] leading-[18px] text-foreground">
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

  return (
    <article className="mx-auto flex w-full max-w-[1180px] flex-col gap-5" aria-labelledby="finding-h">
      <div className="flex flex-col gap-2">
        <nav aria-label="Breadcrumb">
          <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-[12.5px] text-muted-foreground">
            <li className="shrink-0">
              <Link href="/findings" className="hover:text-foreground">
                Findings
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="min-w-0 truncate">
              {finding.title}
            </li>
          </ol>
        </nav>
        <h1 id="finding-h" className="m-0 text-[26px] font-semibold leading-[34px] tracking-[-0.01em] text-foreground">
          {finding.title}
        </h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-muted-foreground">
          <SeverityChip severity={finding.severity} />
          <IssueStatus status={finding.status} triage={finding.triage} viewerName={session.user.name} />
          {finding.assetName === null ? null : <span>on {finding.assetName}</span>}
          {finding.createdAt === undefined ? null : (
            <span>
              found <LocalTime iso={finding.createdAt} style="datetime" />
            </span>
          )}
          {finding.runId === undefined ? null : (
            <Link href={`/runs/${finding.runId}/results`} className="font-medium text-gold-ink underline-offset-2 hover:underline">
              See the audit&rsquo;s results
            </Link>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="rounded-2xl border border-border bg-card p-4 sm:p-5">
            <IssueBody finding={finding}>
              <div className="border-t border-border pt-3.5">
                <FindingTriage finding={finding} />
              </div>
            </IssueBody>
          </div>

          <Card aria-labelledby="replays-h">
            <CardHeader id="replays-h" title="Every replay" meta="Blackwing · no model" />
            <ol className="m-0 flex list-none flex-col divide-y divide-border p-0">
              {replays.length === 0 ? (
                <li className="px-4 py-3 text-[13px] text-muted-foreground">The validator did not replay this one.</li>
              ) : (
                replays.map((r) => (
                  <li key={r.n} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                    <span className="w-20 text-muted-foreground">Replay {r.n}</span>
                    <span className="font-mono">HTTP {r.status}</span>
                    <span className={`ml-auto inline-flex items-center gap-1.5 font-medium ${r.matched ? 'text-ok' : 'text-bad'}`}>
                      <Icon name={r.matched ? 'check' : 'x'} size={13} />
                      {r.matched ? 'Matched' : 'No match'}
                    </span>
                  </li>
                ))
              )}
              {finding.replay?.control === null || finding.replay?.control === undefined ? null : (
                <li className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <span className="w-20 text-muted-foreground">Control</span>
                  <span className="font-mono">HTTP {finding.replay.control.status}</span>
                  <span className={`ml-auto inline-flex items-center gap-1.5 font-medium ${finding.replay.control.matched ? 'text-bad' : 'text-ok'}`}>
                    <Icon name={finding.replay.control.matched ? 'x' : 'check'} size={13} />
                    {finding.replay.control.matched ? 'Matched too' : 'No match, as expected'}
                  </span>
                </li>
              )}
            </ol>
          </Card>

          <details className="group rounded-[14px] border border-border bg-card">
            <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-[14px] font-semibold text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus">
              What the site answered
              <span className="text-[12px] font-normal text-muted-foreground">excerpts, from the target</span>
              <Icon name="chevron" size={16} className="ml-auto text-muted-foreground transition-transform group-open:rotate-180" />
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
              <h2 className="m-0 text-[14.5px] font-semibold text-foreground">Reproduce it</h2>
              <p className="m-0 text-[12.5px] leading-5 text-muted-foreground">
                The same harmless probe the validator sent. It reads; it changes nothing.
              </p>
              <CopyField value={finding.reproCurl} />
            </section>
          )}
          <section className="flex flex-col gap-2 rounded-[14px] border border-border bg-card p-4">
            <h2 className="m-0 text-[14.5px] font-semibold text-foreground">Report</h2>
            {released ? (
              <div className="flex flex-col gap-2">
                <LinkButton href={`${report}?format=html`} variant="secondary" icon="download" className="w-full">
                  Download (HTML)
                </LinkButton>
                <LinkButton href={`${report}?format=md`} variant="ghost" icon="download" className="w-full">
                  Download (Markdown)
                </LinkButton>
              </div>
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
              <Link href="/ledger#verify" className="ml-auto font-medium text-gold-ink hover:underline">
                Verify
              </Link>
            </p>
          )}
        </aside>
      </div>
    </article>
  );
}
