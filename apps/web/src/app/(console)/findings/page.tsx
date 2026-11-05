// Findings (experience spec §2, §8): every finding in the workspace, newest first, filtered by status (including Kept
// back), severity and target through the URL, so each filter is a link that prefetches and survives a reload.
import Link from 'next/link';
import { z } from 'zod';

import { EmptyState, filterPillClass, LinkButton, SeverityChip, queryText } from '../../../components/console/design';
import { IssueStatus } from '../../../components/console/results/issue-list';
import { LocalTime } from '../../../components/console/results/local-time';
import { agentName } from '../../../lib/agents';
import { callApi } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';
import { findingSummarySchema } from '../../../lib/schemas';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Findings' };

const listSchema = z.object({ items: z.array(findingSummarySchema) });

const STATUSES = [
  { key: 'confirmed', label: 'Awaiting release' },
  { key: 'released', label: 'Released' },
  { key: 'suspected', label: 'Kept back' },
  { key: 'dismissed', label: 'Dismissed' },
] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

interface Filters {
  status?: string | undefined;
  severity?: string | undefined;
  target?: string | undefined;
}

function hrefWith(filters: Filters, key: keyof Filters, value: string | undefined): string {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...filters, [key]: value })) if (v !== undefined) query.set(k, v);
  const text = query.toString();
  return text === '' ? '/findings' : `/findings?${text}`;
}

function FilterRow({
  label,
  param,
  options,
  filters,
}: {
  readonly label: string;
  readonly param: keyof Filters;
  readonly options: readonly { key: string; label: string; count: number }[];
  readonly filters: Filters;
}) {
  const active = filters[param];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="w-[68px] shrink-0 text-[12px] text-muted-foreground">{label}</span>
      {[{ key: undefined, label: 'All', count: -1 }, ...options].map((o) => (
        <Link
          key={o.key ?? 'all'}
          href={hrefWith(filters, param, o.key)}
          scroll={false}
          aria-current={active === o.key ? 'true' : undefined}
          className={`${filterPillClass(active === o.key)} h-8`}
        >
          {o.label}
          {o.count < 0 ? null : <span className="ml-1.5 tabular-nums opacity-60">{o.count}</span>}
        </Link>
      ))}
    </div>
  );
}

export default async function FindingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const query = await searchParams;
  const { items } = listSchema.parse(await callApi(session, '/findings'));
  const targets = [...new Set(items.map((f) => f.assetName).filter((n): n is string => n !== null))].sort();
  const filters: Filters = {
    status: STATUSES.find((s) => s.key === queryText(query.status))?.key,
    severity: SEVERITIES.find((s) => s === queryText(query.severity)),
    target: targets.find((t) => t === queryText(query.target)),
  };
  const match = (f: (typeof items)[number], skip?: keyof Filters): boolean =>
    (skip === 'status' || filters.status === undefined || f.status === filters.status) &&
    (skip === 'severity' || filters.severity === undefined || f.severity === filters.severity) &&
    (skip === 'target' || filters.target === undefined || f.assetName === filters.target);
  const shown = items.filter((f) => match(f));
  const countBy = (skip: keyof Filters, test: (f: (typeof items)[number]) => boolean): number =>
    items.filter((f) => match(f, skip) && test(f)).length;
  const filtered = filters.status !== undefined || filters.severity !== undefined || filters.target !== undefined;

  return (
    <div className="flex w-full max-w-[1100px] flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground">Findings</h1>
        <p className="m-0 max-w-[68ch] text-[14px] leading-[22px] text-muted-foreground">
          Every issue Claude&rsquo;s team raised. Proven ones were replayed by the validator with a control; kept-back ones
          were not proven and stay off reports unless you release them with a reason.
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon="findings"
          title="No findings yet."
          body="They appear here once Claude proves an issue. Start an audit of a site you own to begin."
          action={
            <LinkButton href="/audits/new" variant="primary" icon="plus">
              New audit
            </LinkButton>
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <FilterRow
              label="Status"
              param="status"
              filters={filters}
              options={STATUSES.map((s) => ({ key: s.key, label: s.label, count: countBy('status', (f) => f.status === s.key) }))}
            />
            <FilterRow
              label="Severity"
              param="severity"
              filters={filters}
              options={SEVERITIES.map((s) => ({ key: s, label: cap(s), count: countBy('severity', (f) => f.severity === s) })).filter(
                (o) => o.count > 0 || o.key === filters.severity,
              )}
            />
            {targets.length > 1 ? (
              <FilterRow
                label="Target"
                param="target"
                filters={filters}
                options={targets.map((t) => ({ key: t, label: t, count: countBy('target', (f) => f.assetName === t) }))}
              />
            ) : null}
          </div>

          {shown.length === 0 ? (
            <EmptyState
              title="No findings match these filters."
              body={filtered ? 'Try another status or severity.' : undefined}
              action={
                <LinkButton href="/findings" variant="secondary">
                  Clear filters
                </LinkButton>
              }
            />
          ) : (
            <ul className="m-0 flex list-none flex-col overflow-hidden rounded-[14px] border border-border bg-card p-0">
              {shown.map((f) => (
                <li key={f.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={`/findings/${f.id}`}
                    className="flex min-h-[60px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-focus"
                  >
                    <span className="w-[88px] shrink-0">
                      <SeverityChip severity={f.severity} />
                    </span>
                    <span className="flex min-w-0 flex-1 basis-60 flex-col">
                      <span className="text-[14.5px] font-medium leading-[21px] text-foreground">{f.title}</span>
                      <span className="text-[12.5px] text-muted-foreground">
                        {[f.assetName, f.agent === null ? null : `found by the ${agentName(f.agent)}`].filter(Boolean).join(' · ')}
                        {f.createdAt === undefined ? null : (
                          <>
                            {' · '}
                            <LocalTime iso={f.createdAt} style="datetime" />
                          </>
                        )}
                      </span>
                    </span>
                    <span className="ml-auto shrink-0">
                      <IssueStatus status={f.status} triage={undefined} viewerName={session.user.name} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
