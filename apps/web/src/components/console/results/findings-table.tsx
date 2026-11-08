'use client';

// The findings list with its filters (experience spec §2, §8). The server sends every finding once; filtering happens
// here, so a filter click is instant (local state, no server round trip). The URL follows with history.pushState,
// and the list re-reads it whenever the router's URL changes (useSearchParams), so Back, a reload or a shared link all
// show the same filtered list. URL values are read forgivingly (any case, spaces, the label or the key). Status and
// severity are chips (few, fixed options); target and audit are menus, because they grow with every audit run (each
// audit is named by its target and when it started).
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';

import { agentName } from '../../../lib/agents';
import { buttonClass, EmptyState, SeverityChip } from '../design';
import { IssueStatus } from './issue-list';
import { LocalTime } from './local-time';
import { FINDING_STATUSES, seenBeforeText, SEVERITIES, type FindingSummary } from './model';
import { NavLink } from './nav-link';

const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);
/** A URL value this long may be the start of a label ("kept" for Kept back). */
const PREFIX_MIN = 4;
const SHORT_ID = 8;
const fold = (v: string): string =>
  v
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');

export interface FindingFilters {
  readonly status?: string | undefined;
  readonly severity?: string | undefined;
  readonly target?: string | undefined;
  readonly audit?: string | undefined;
}
type Key = keyof FindingFilters;

/** The filters a URL asks for, matched forgivingly; anything unknown is ignored. */
function parseFilters(
  read: (key: Key) => string | null,
  targets: readonly string[],
  audits: readonly string[] = [],
): FindingFilters {
  const want = (key: Key): string | null => {
    const v = read(key);
    return v === null || v.trim() === '' ? null : fold(v);
  };
  const status = want('status');
  const severity = want('severity');
  const target = want('target');
  const audit = want('audit');
  return {
    status: FINDING_STATUSES.find(
      (s) =>
        status !== null &&
        (fold(s.key) === status ||
          fold(s.label) === status ||
          (status.length >= PREFIX_MIN && fold(s.label).startsWith(status))),
    )?.key,
    severity: SEVERITIES.find((s) => s === severity),
    target: targets.find((t) => target !== null && fold(t) === target),
    // An audit id, or the short id people copy (its last 8 characters, as the ledger and results show it).
    audit: audits.find(
      (a) =>
        audit !== null &&
        audit.length >= SHORT_ID &&
        (fold(a).startsWith(audit) || a.replace(/-/g, '').toLowerCase().endsWith(audit)),
    ),
  };
}

/** Selected is gold-soft with gold ink (the palette's "chosen"), never the ink black of a Deny button. */
function pillClass(active: boolean, empty: boolean): string {
  const state = active
    ? 'border-gold-line bg-gold-soft text-gold-ink'
    : empty
      ? 'cursor-default border-dashed border-border-strong bg-transparent text-muted-foreground'
      : 'border-transparent bg-surface-2 text-foreground hover:border-border-strong';
  return `inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${state}`;
}

function FilterRow({
  label,
  options,
  active,
  onPick,
}: {
  readonly label: string;
  readonly options: readonly { key: string; label: ReactNode; count: number }[];
  readonly active: string | undefined;
  readonly onPick: (key: string | undefined) => void;
}) {
  return (
    // The chips wrap at every width: no option ever hides past the edge of a phone screen.
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="w-[60px] shrink-0 text-[12px] text-muted-foreground sm:w-[68px]">
        {label}
      </span>
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
          {/* The count is its own small badge, so "Released 6" never reads as one word or number. */}
          {o.count < 0 ? null : (
            <span className="ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-card/80 px-1.5 text-[11px] tabular-nums text-muted-foreground">
              {o.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

const SELECT_CLASS =
  'h-9 min-w-0 max-w-full flex-1 cursor-pointer appearance-none truncate rounded-[10px] border pl-3 pr-8 text-[13px] focus-visible:border-gold-ink focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus sm:w-[260px] sm:flex-none';
/** The menu's chevron (a data URI cannot follow the theme, so it uses a mid grey that reads on both). */
export const CHEVRON = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 10px center',
  backgroundSize: '16px',
} as const;

/** A filter that grows with use (targets, audits): a native menu, so it stays one line however many there are. */
function FilterMenu({
  label,
  all,
  options,
  active,
  onPick,
}: {
  readonly label: string;
  readonly all: string;
  readonly options: readonly { key: string; label: string; count: number }[];
  readonly active: string | undefined;
  readonly onPick: (key: string | undefined) => void;
}) {
  const id = `filter-${label.toLowerCase()}`;
  return (
    <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto">
      <label
        htmlFor={id}
        className="w-[60px] shrink-0 text-[12px] text-muted-foreground sm:w-[68px]"
      >
        {label}
      </label>
      <select
        id={id}
        value={active ?? ''}
        onChange={(e) => {
          onPick(e.target.value === '' ? undefined : e.target.value);
        }}
        className={`${SELECT_CLASS} ${active === undefined ? 'border-input-strong bg-card text-foreground' : 'border-gold-line bg-gold-soft text-gold-ink'}`}
        style={CHEVRON}
      >
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.key} value={o.key} disabled={o.count === 0 && active !== o.key}>
            {o.label} ({o.count})
          </option>
        ))}
      </select>
    </div>
  );
}

/** An audit the findings came from: its target and when it started (from the run list when the page had it). */
export interface AuditOption {
  readonly id: string;
  readonly target: string | null;
  readonly startedAt: string | null;
}

/** Formats a time only in the browser (the server's zone must never show, and must not differ at hydration). */
function useClock(): ((iso: string) => string) | null {
  const [format, setFormat] = useState<((iso: string) => string) | null>(null);
  useEffect(() => {
    const f = new Intl.DateTimeFormat(undefined, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
    setFormat(() => (iso: string) => f.format(new Date(iso)));
  }, []);
  return format;
}

/** Rows rendered at first and per "Show more": a long workspace list stays a page, not 11,000 px. */
export const FINDINGS_PAGE = 50;

export function FindingsTable({
  items,
  runs = [],
}: {
  readonly items: readonly FindingSummary[];
  /** Start times of the audits, when the page could read them; otherwise an audit is dated by its first finding. */
  readonly runs?: readonly AuditOption[];
}) {
  const params = useSearchParams();
  const clock = useClock();
  const targets = [
    ...new Set(items.map((f) => f.assetName).filter((n): n is string => n !== null)),
  ].sort();
  // Each audit with findings, newest first: its start time, or else when it found its first issue.
  const known = new Map(runs.map((r) => [r.id, r]));
  const firstAt = new Map<string, string>();
  for (const f of items)
    if (f.runId !== undefined) {
      const at = known.get(f.runId)?.startedAt ?? f.createdAt ?? '';
      const seen = firstAt.get(f.runId);
      if (seen === undefined || at < seen) firstAt.set(f.runId, at);
    }
  const audits = [...firstAt.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([id]) => id);
  const fromUrl = parseFilters((k) => params.get(k), targets, audits);
  const [filters, setFilters] = useState<FindingFilters>(fromUrl);
  const [limit, setLimit] = useState(FINDINGS_PAGE);
  const urlKey = params.toString();
  useEffect(() => {
    setFilters(parseFilters((k) => new URLSearchParams(urlKey).get(k), targets, audits));
    setLimit(FINDINGS_PAGE);
    // targets derive from items; the URL is what changes on Back.
  }, [urlKey]);

  const write = (next: FindingFilters): void => {
    setFilters(next);
    setLimit(FINDINGS_PAGE);
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (typeof v === 'string') query.set(k, v);
    const text = query.toString();
    window.history.pushState(null, '', text === '' ? '/findings' : `/findings?${text}`);
  };
  const pick = (key: Key, value: string | undefined): void => {
    write({ ...filters, [key]: value });
  };
  const match = (f: FindingSummary, skip?: Key): boolean =>
    (skip === 'status' || filters.status === undefined || f.status === filters.status) &&
    (skip === 'severity' || filters.severity === undefined || f.severity === filters.severity) &&
    (skip === 'target' || filters.target === undefined || f.assetName === filters.target) &&
    (skip === 'audit' || filters.audit === undefined || f.runId === filters.audit);
  const countBy = (skip: Key, test: (f: FindingSummary) => boolean): number =>
    items.filter((f) => match(f, skip) && test(f)).length;
  const shown = items.filter((f) => match(f));
  const auditLabel = (id: string): string => {
    const run = known.get(id);
    const target = run?.target ?? items.find((f) => f.runId === id)?.assetName ?? 'Audit';
    const at = firstAt.get(id) ?? '';
    // Until the browser formats the time (a moment after load), the short id tells audits apart.
    if (at === '' || clock === null) return `${target} · ${id.slice(0, SHORT_ID)}`;
    return `${target} · ${clock(at)}`;
  };

  return (
    <>
      <div className="flex flex-col gap-2">
        <FilterRow
          label="Status"
          active={filters.status}
          onPick={(v) => {
            pick('status', v);
          }}
          options={FINDING_STATUSES.map((s) => ({
            key: s.key,
            label: s.label,
            count: countBy('status', (f) => f.status === s.key),
          }))}
        />
        <FilterRow
          label="Severity"
          active={filters.severity}
          onPick={(v) => {
            pick('severity', v);
          }}
          options={SEVERITIES.map((s) => ({
            key: s,
            label: cap(s),
            count: countBy('severity', (f) => f.severity === s),
          }))}
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <FilterMenu
            label="Target"
            all="All targets"
            active={filters.target}
            onPick={(v) => {
              pick('target', v);
            }}
            options={targets.map((t) => ({
              key: t,
              label: t,
              count: countBy('target', (f) => f.assetName === t),
            }))}
          />
          <FilterMenu
            label="Audit"
            all="All audits"
            active={filters.audit}
            onPick={(v) => {
              pick('audit', v);
            }}
            options={audits
              .filter(
                (a) =>
                  filters.target === undefined ||
                  a === filters.audit ||
                  items.some((f) => f.runId === a && f.assetName === filters.target),
              )
              .map((a) => ({
              key: a,
              label: auditLabel(a),
              count: countBy('audit', (f) => f.runId === a),
            }))}
          />
          {Object.values(filters).some((v) => v !== undefined) ? (
            <button
              type="button"
              className="h-9 rounded-md px-1 text-[12.5px] font-medium text-gold-ink underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
              onClick={() => {
                write({});
              }}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="mx-auto w-full max-w-[560px]">
          <EmptyState
            title="No findings match these filters."
            body="Try another status, severity, target or audit."
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
          {shown.slice(0, limit).map((f) => (
            <li key={f.id} className="border-b border-border last:border-b-0">
              <NavLink
                href={`/findings/${f.id}`}
                className="flex min-h-[60px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-focus"
              >
                <span className="w-[88px] shrink-0">
                  <SeverityChip severity={f.severity} />
                </span>
                <span className="flex min-w-0 flex-1 basis-60 flex-col">
                  <span className="text-[14.5px] font-medium leading-[21px] text-foreground">
                    {f.title}
                  </span>
                  {seenBeforeText(f) === null ? null : (
                    <span className="text-[12.5px] font-medium text-gold-ink">{seenBeforeText(f)}</span>
                  )}
                  <span className="text-[12.5px] text-muted-foreground">
                    {[f.assetName, f.agent === null ? null : `found by the ${agentName(f.agent)}`]
                      .filter(Boolean)
                      .join(' · ')}
                    {f.createdAt === undefined ? null : (
                      <LocalTime iso={f.createdAt} style="datetime" prefix=" · " />
                    )}
                  </span>
                </span>
                <span className="ml-auto shrink-0">
                  <IssueStatus status={f.status} />
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
      {shown.length > limit ? (
        <div className="flex flex-wrap items-center justify-center gap-3 text-[12.5px] text-muted-foreground">
          <span>
            Showing {limit.toLocaleString()} of {shown.length.toLocaleString()}
          </span>
          <button
            type="button"
            className={buttonClass('secondary')}
            onClick={() => {
              setLimit((n) => n + FINDINGS_PAGE);
            }}
          >
            Show {Math.min(FINDINGS_PAGE, shown.length - limit).toLocaleString()} more
          </button>
        </div>
      ) : null}
    </>
  );
}
