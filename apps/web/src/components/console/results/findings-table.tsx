'use client';

// The findings list with its filters (experience spec §2, §8). The server sends every finding once; filtering happens
// here, so a filter click is instant (local state, no server round trip). The URL follows with history.replaceState,
// and the list re-reads it whenever the router's URL changes (useSearchParams), so Back, a reload or a shared link all
// show the same filtered list. URL values are read forgivingly (any case, spaces, the label or the key).
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { agentName } from '../../../lib/agents';
import { buttonClass, EmptyState, SeverityChip } from '../design';
import { IssueStatus } from './issue-list';
import { LocalTime } from './local-time';
import { FINDING_STATUSES, SEVERITIES, type FindingSummary } from './model';

const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);
/** A URL value this long may be the start of a label ("kept" for Kept back). */
const PREFIX_MIN = 4;
const fold = (v: string): string => v.trim().toLowerCase().replace(/[\s_-]+/g, ' ');

export interface FindingFilters {
  readonly status?: string | undefined;
  readonly severity?: string | undefined;
  readonly target?: string | undefined;
}
type Key = keyof FindingFilters;

/** The filters a URL asks for, matched forgivingly; anything unknown is ignored. */
export function parseFilters(
  read: (key: Key) => string | null,
  targets: readonly string[],
): FindingFilters {
  const want = (key: Key): string | null => {
    const v = read(key);
    return v === null || v.trim() === '' ? null : fold(v);
  };
  const status = want('status');
  const severity = want('severity');
  const target = want('target');
  return {
    status: FINDING_STATUSES.find(
      (s) =>
        status !== null &&
        (fold(s.key) === status || fold(s.label) === status || (status.length >= PREFIX_MIN && fold(s.label).startsWith(status))),
    )?.key,
    severity: SEVERITIES.find((s) => s === severity),
    target: targets.find((t) => target !== null && fold(t) === target),
  };
}

/** Selected is gold-soft with gold ink (the palette's "chosen"), never the ink black of a Deny button. */
function pillClass(active: boolean, empty: boolean): string {
  const state = active
    ? 'border-gold-line bg-gold-soft text-gold-ink'
    : empty
      ? 'cursor-default border-transparent bg-surface-2 text-muted-foreground opacity-60'
      : 'border-transparent bg-surface-2 text-foreground hover:border-border-strong';
  return `inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${state}`;
}

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
          // Options never vanish: an empty one stays in place, disabled, with its 0.
          disabled={o.count === 0 && active !== o.key}
          onClick={() => {
            onPick(o.key);
          }}
          className={pillClass(active === o.key, o.count === 0)}
        >
          {o.label}
          {o.count < 0 ? null : <span className="ml-1.5 tabular-nums opacity-60">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function FindingsTable({ items }: { readonly items: readonly FindingSummary[] }) {
  const params = useSearchParams();
  const targets = [...new Set(items.map((f) => f.assetName).filter((n): n is string => n !== null))].sort();
  const fromUrl = parseFilters((k) => params.get(k), targets);
  const [filters, setFilters] = useState<FindingFilters>(fromUrl);
  const urlKey = params.toString();
  useEffect(() => {
    setFilters(parseFilters((k) => new URLSearchParams(urlKey).get(k), targets));
    // targets derive from items; the URL is what changes on Back.
  }, [urlKey]);

  const write = (next: FindingFilters): void => {
    setFilters(next);
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (typeof v === 'string') query.set(k, v);
    const text = query.toString();
    window.history.replaceState(null, '', text === '' ? '/findings' : `/findings?${text}`);
  };
  const pick = (key: Key, value: string | undefined): void => {
    write({ ...filters, [key]: value });
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
          options={SEVERITIES.map((s) => ({ key: s, label: cap(s), count: countBy('severity', (f) => f.severity === s) }))}
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
        <div className="mx-auto w-full max-w-[560px]">
        <EmptyState
          title="No findings match these filters."
          body="Try another status, severity or target."
          action={
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() => {
                write({});
              }}
            >
              Clear filters
            </button>
          }
        />
        </div>
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
                    {f.createdAt === undefined ? null : <LocalTime iso={f.createdAt} style="datetime" prefix=" · " />}
                  </span>
                </span>
                <span className="ml-auto shrink-0">
                  <IssueStatus status={f.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
