'use client';

// The issue list of the results page (experience spec §7): the first issue is open, the rest expand in place (fetched
// once through /api/findings/[id] and cached). Gate 3 sits on each open issue; "Release all proven" sends one request
// per finding with the shared reason (one server action, so the ledger records one event each and the page refreshes
// once). R releases the issue you opened last, or else the first open one that still awaits release.
import { startTransition, useEffect, useRef, useState } from 'react';

import { buttonClass, Chip, Icon, InlineMessage, SeverityChip, Skeleton } from '../design';
import { PendingButton, ReasonField } from '../design-client';
import { IssueBody } from './issue-body';
import { findingDetailSchema, seenBeforeText, type FindingDetail, type FindingSummary } from './model';
import { NavLink } from './nav-link';
import {
  announceChange,
  CopyButton,
  escapeCloses,
  PROVEN_REASON,
  REASON_NOTE,
  TriageControls,
  useReleaseKey,
  useSettledAction,
} from './triage';
import { releaseFindingsAction } from '../../../app/(console)/findings/actions';
import { reasonEnough } from '../../../lib/normalize';

/**
 * One short status, the same everywhere (lists, issue headers, detail): who decided and when is said once, in the
 * open issue. Each state has its own mark, so none looks like missing styling.
 */
export function IssueStatus({
  status,
  pill = false,
}: {
  readonly status: string;
  readonly pill?: boolean;
}) {
  const base =
    'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium';
  if (status === 'confirmed')
    return (
      // On an open issue the decision it waits for anchors the header as a gold pill; in lists it stays a dot.
      <span
        className={`${base} text-gold-ink ${pill ? 'h-[24px] rounded-full border border-gold-line bg-gold-soft px-2.5' : ''}`}
      >
        <span aria-hidden="true" className="size-2 rounded-full bg-current" />
        Awaiting your release
      </span>
    );
  if (status === 'released')
    return (
      <span className={`${base} text-ok`}>
        <Icon name="check" size={13} />
        Released
      </span>
    );
  if (status === 'dismissed')
    return (
      <span className={`${base} text-muted-foreground`}>
        <Icon name="minus" size={13} />
        Dismissed
      </span>
    );
  return (
    <span
      className={`${base} h-[22px] rounded-full border border-dashed border-border-strong px-2 text-muted-foreground`}
    >
      Kept back
    </span>
  );
}

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; finding: FindingDetail };

function useDetails(initial: readonly FindingDetail[]) {
  const [details, setDetails] = useState<Record<string, Load>>(() =>
    Object.fromEntries(initial.map((f) => [f.id, { state: 'ready', finding: f } as const])),
  );
  const load = (id: string): void => {
    const current = details[id];
    if (current !== undefined && current.state !== 'error') return;
    setDetails((d) => ({ ...d, [id]: { state: 'loading' } }));
    fetch(`/api/findings/${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const finding = findingDetailSchema.parse(await r.json());
        setDetails((d) => ({ ...d, [id]: { state: 'ready', finding } }));
      })
      .catch(() => {
        setDetails((d) => ({ ...d, [id]: { state: 'error' } }));
      });
  };
  const put = (finding: FindingDetail): void => {
    setDetails((d) => ({ ...d, [finding.id]: { state: 'ready', finding } }));
  };
  const drop = (id: string): void => {
    setDetails((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== id)));
  };
  return { details, load, put, drop };
}

export function IssueList({
  items,
  initial,
  viewerName,
  openFirst = true,
  openId,
  shortcuts = false,
  dashed = false,
}: {
  readonly items: readonly FindingSummary[];
  readonly initial: readonly FindingDetail[];
  readonly viewerName: string;
  readonly openFirst?: boolean;
  /** The issue to open first (default: the first in the list). */
  readonly openId?: string | undefined;
  /** Bind R to the open issue's release (one list per page). */
  readonly shortcuts?: boolean;
  readonly dashed?: boolean;
}) {
  const { details, load, put, drop } = useDetails(initial);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    const first = openId ?? items[0]?.id;
    return new Set(openFirst && first !== undefined ? [first] : []);
  });
  const release = useReleaseKey(shortcuts);
  const lastOpened = useRef<string | null>(null);

  // After a refresh the server's list wins: a status that changed elsewhere (another tab, Release all) reloads the issue.
  const seen = useRef(new Map(items.map((s) => [s.id, s.status])));
  useEffect(() => {
    for (const s of items) {
      const before = seen.current.get(s.id);
      seen.current.set(s.id, s.status);
      const d = details[s.id];
      if (
        before !== undefined &&
        before !== s.status &&
        d?.state === 'ready' &&
        d.finding.status !== s.status
      )
        drop(s.id);
    }
    for (const id of open) if (details[id] === undefined) load(id);
  });

  const toggle = (id: string): void => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      lastOpened.current = id;
      load(id);
    }
    setOpen(next);
  };
  const statusOf = (s: FindingSummary): string => {
    const d = details[s.id];
    return d?.state === 'ready' ? d.finding.status : s.status;
  };
  const releasable = (s: FindingSummary): boolean =>
    open.has(s.id) && (statusOf(s) === 'confirmed' || statusOf(s) === 'suspected');
  // R follows your attention: the issue you opened last, else the first open one still awaiting release.
  const keyTarget = (
    items.find((s) => s.id === lastOpened.current && releasable(s)) ??
    items.find((s) => releasable(s))
  )?.id;

  return (
    <div className="flex flex-col gap-2.5">
      {items.map((s) => {
        const isOpen = open.has(s.id);
        const d = details[s.id];
        const finding = d?.state === 'ready' ? d.finding : null;
        const status = finding?.status ?? s.status;
        const bodyId = `issue-${s.id}`;
        return (
          <article
            key={s.id}
            className={`min-w-0 rounded-2xl border bg-card transition-shadow ${dashed ? 'border-dashed border-border-strong' : 'border-border'} ${isOpen ? 'shadow-[0_8px_28px_rgba(31,23,4,.06)]' : ''}`}
          >
            <h3 className="m-0">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={bodyId}
                onClick={() => {
                  toggle(s.id);
                }}
                // The title has the whole first line; status and "seen before" sit on the line below it.
                className="grid min-h-[52px] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 rounded-2xl px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus sm:px-5"
              >
                <SeverityChip severity={s.severity} />
                <span className="min-w-0 text-[15px] font-semibold leading-[22px] text-foreground">{s.title}</span>
                <Icon
                  name="chevron"
                  size={16}
                  className={`text-muted-foreground transition-transform ${isOpen ? 'rotate-180' : ''}`}
                />
                <span className="col-start-2 flex flex-wrap items-center gap-2">
                  <IssueStatus status={status} pill={isOpen} />
                  {seenBeforeText(s) === null ? null : <Chip tone="neutral">{seenBeforeText(s)}</Chip>}
                </span>
              </button>
            </h3>
            {isOpen ? (
              <div id={bodyId} className="border-t border-border px-4 pb-4 pt-3.5 sm:px-5">
                {d === undefined || d.state === 'loading' ? (
                  <div className="flex flex-col gap-2" aria-busy="true">
                    <span className="sr-only">Loading the proof…</span>
                    <Skeleton className="h-16" />
                    <Skeleton className="h-24" />
                  </div>
                ) : d.state === 'error' ? (
                  <InlineMessage tone="bad">
                    We couldn&rsquo;t load this issue.{' '}
                    <button
                      type="button"
                      className="font-medium underline"
                      onClick={() => {
                        load(s.id);
                      }}
                    >
                      Retry
                    </button>
                  </InlineMessage>
                ) : (
                  <IssueBody finding={d.finding}>
                    <div className="border-t border-border pt-3.5">
                      <TriageControls
                        finding={d.finding}
                        viewerName={viewerName}
                        onDone={(updated) => {
                          if (updated === null) drop(s.id);
                          else put(updated);
                        }}
                        primary={!dashed && s.id === keyTarget}
                        {...(shortcuts && s.id === keyTarget
                          ? {
                              bindRelease: (fn: (() => void) | null) => {
                                release.current = fn;
                              },
                            }
                          : {})}
                        trailing={
                          <>
                            {d.finding.reproCurl === '' ? null : (
                              <CopyButton text={d.finding.reproCurl} label="Copy as curl" />
                            )}
                            <NavLink
                              href={`/findings/${s.id}`}
                              className={buttonClass('ghost', 'h-9 px-3 text-[13px]')}
                            >
                              <Icon name="file" size={14} />
                              Full evidence
                            </NavLink>
                          </>
                        }
                      />
                    </div>
                  </IssueBody>
                )}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

/** "Release all proven": one triage call per awaiting finding with the shared reason (one ledger event each). */
export function ReleaseAll({ ids, runId = null }: { readonly ids: readonly string[]; readonly runId?: string | null }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState(PROVEN_REASON);
  const [error, setError] = useState<string | null>(null);
  const { settling, run } = useSettledAction();
  if (ids.length < 2) return null;

  async function releaseAll(): Promise<void> {
    if (settling || !reasonEnough(reason)) return;
    setError(null);
    await run(async () => {
      const result = await releaseFindingsAction(ids, reason, runId);
      startTransition(() => {
        if (!result.ok) setError(result.message);
        else if (result.data.failed > 0)
          setError(
            `${result.data.failed} of ${ids.length} could not be released. The others are released; try again.`,
          );
        else setAsking(false);
      });
      announceChange();
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-gold-line bg-gold-soft px-4 py-2.5 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="m-0 min-w-0 flex-1 basis-56 text-[13.5px] leading-5 text-foreground">
          <b className="font-semibold">{ids.length} proven issues wait for your release.</b>{' '}
          <span className="text-muted-foreground">One reason for all, or one at a time below.</span>
        </p>
        {asking ? null : (
          <button
            type="button"
            className={buttonClass('secondary', 'h-9 px-3.5 text-[13px]')}
            onClick={() => {
              setAsking(true);
            }}
          >
            <Icon name="check" size={14} />
            Release all {ids.length}
          </button>
        )}
      </div>
      {asking ? (
        <div
          className="flex flex-col gap-3 pb-1.5"
          onKeyDown={escapeCloses(() => {
            setAsking(false);
          })}
        >
          <ReasonField
            label={`Why release all ${ids.length} to the report?`}
            value={reason}
            onChange={setReason}
            autoFocus
            rows={2}
            footnote={REASON_NOTE.replace('with your name', 'with your name, once per issue')}
            onSubmit={() => {
              void releaseAll();
            }}
          />
          {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
          <div className="flex flex-wrap items-center gap-2">
            <PendingButton
              pendingLabel={`Releasing ${ids.length} issues…`}
              disabled={!reasonEnough(reason) || settling}
              stayPending
              onAction={async () => {
                await releaseAll();
                return false;
              }}
            >
              Release {ids.length} issues
            </PendingButton>
            <button
              type="button"
              className={buttonClass('ghost')}
              disabled={settling}
              onClick={() => {
                setAsking(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The dashed "Kept back" row (shown only when something was suspected): Review expands the unproven issues. */
export function KeptBack({
  items,
  viewerName,
}: {
  readonly items: readonly FindingSummary[];
  readonly viewerName: string;
}) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const waiting = items.filter((f) => f.status === 'suspected').length;
  const text =
    waiting > 0 ? (
      <>
        <b className="font-semibold text-foreground">
          {waiting} more {waiting === 1 ? 'was' : 'were'} suspected but not proven.
        </b>{' '}
        They stay off the report unless you review them and release with a reason.
      </>
    ) : (
      <>
        <b className="font-semibold text-foreground">
          You reviewed the {items.length === 1 ? 'issue' : `${items.length} issues`} that{' '}
          {items.length === 1 ? 'was' : 'were'} kept back.
        </b>{' '}
        Your decisions are listed below.
      </>
    );
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-border-strong px-4 py-3 sm:px-5">
        <Icon name="eye" size={16} className="text-muted-foreground" />
        <p className="m-0 min-w-0 flex-1 basis-56 text-[13px] leading-5 text-muted-foreground">
          {text}
        </p>
        <button
          type="button"
          aria-expanded={open}
          className={buttonClass('ghost', 'h-9 px-3 text-[13px]')}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? 'Hide' : 'Review'}
        </button>
      </div>
      {open ? <IssueList items={items} initial={[]} viewerName={viewerName} dashed /> : null}
    </div>
  );
}
