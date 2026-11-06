'use client';

// The findings list with its filters (experience spec §2, §8). The server sends every finding once; filtering happens
// here, so a filter click is instant (no server round trip), and the URL follows with history.replaceState, so a reload
// or a shared link keeps the filters.
import Link from 'next/link';
import { useState } from 'react';

import { agentName } from '../../../lib/agents';
import { buttonClass, EmptyState, filterPillClass, SeverityChip } from '../design';
import { IssueStatus } from './issue-list';
import { LocalTime } from './local-time';
import { FINDING_STATUSES, SEVERITIES, type FindingSummary } from './model';

const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

export interface FindingFilters {
  readonly status?: string | undefined;
  readonly severity?: string | undefined;
  readonly target?: string | undefined;
}
type Key = keyof FindingFilters;

function FilterRow({
  label,
  options,
  active,
  onPick,
}: {
  readonly label: string;
  readonly options: readonly { key: string; label: string; count: number }[];
  readonly active: string | undefined;
  readonly onPick: (key: string | undefined) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="w-[68px] shrink-0 text-[12px] text-muted-foreground">{label}</span>
      {[{ key: undefined, label: 'All', count: -1 }, ...options].map((o) => (
        <button
          key={o.key ?? 'all'}
          type="button"
          aria-pressed={active === o.key}
          onClick={() => {
            onPick(o.key);
          }}
          className={`${filterPillClass(active === o.key)} h-8`}
        >
          {o.label}
          {o.count < 0 ? null : <span className="ml-1.5 tabular-nums opacity-60">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function FindingsTable({
  items,
  initial,
  viewerName,
}: {
  readonly items: readonly FindingSummary[];
  readonly initial: FindingFilters;
  readonly viewerName: string;
}) {
  const [filters, setFilters] = useState<FindingFilters>(initial);
  const targets = [...new Set(items.map((f) => f.assetName).filter((n): n is string => n !== null))].sort();

  const pick = (key: Key, value: string | undefined): void => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (typeof v === 'string') query.set(k, v);
    const text = query.toString();
    window.history.replaceState(null, '', text === '' ? '/findings' : `/findings?${text}`);
  };
  const match = (f: FindingSummary, skip?: Key): boolean =>
    (skip === 'status' || filters.status === undefined || f.status === filters.status) &&
    (skip === 'severity' || filters.severity === undefined || f.severity === filters.severity) &&
    (skip === 'target' || filters.target === undefined || f.assetName === filters.target);
  const countBy = (skip: Key, test: (f: FindingSummary) => boolean): number =>
    items.filter((f) => match(f, skip) && test(f)).length;
  const shown = items.filter((f) => match(f));

  return (
    <>
      <div className="flex flex-col gap-2">
        <FilterRow
          label="Status"
          active={filters.status}
          onPick={(v) => {
            pick('status', v);
          }}
          options={FINDING_STATUSES.map((s) => ({ key: s.key, label: s.label, count: countBy('status', (f) => f.status === s.key) }))}
        />
        <FilterRow
          label="Severity"
          active={filters.severity}
          onPick={(v) => {
            pick('severity', v);
          }}
          options={SEVERITIES.map((s) => ({ key: s, label: cap(s), count: countBy('severity', (f) => f.severity === s) })).filter(
            (o) => o.count > 0 || o.key === filters.severity,
          )}
        />
        {targets.length > 1 ? (
          <FilterRow
            label="Target"
            active={filters.target}
            onPick={(v) => {
              pick('target', v);
            }}
            options={targets.map((t) => ({ key: t, label: t, count: countBy('target', (f) => f.assetName === t) }))}
          />
        ) : null}
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title="No findings match these filters."
          body="Try another status, severity or target."
          action={
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() => {
                setFilters({});
                window.history.replaceState(null, '', '/findings');
              }}
            >
              Clear filters
            </button>
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
                  <IssueStatus status={f.status} triage={undefined} viewerName={viewerName} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
