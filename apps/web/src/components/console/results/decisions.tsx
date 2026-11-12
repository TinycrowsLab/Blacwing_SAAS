// "Your decisions" (experience spec §7): every human decision on this audit with its reason and time, and the ledger's
// chain state. Rows come from `decisions()` (model.ts); nothing here is invented.
import { Fragment } from 'react';

import { Icon, VoiceTag } from '../design';
import { Markdown } from '../markdown';
import { Disclosure } from './disclosure';
import { LocalTime } from './local-time';
import { NavLink } from './nav-link';

import type { DecisionRow, Ledger, NotTested } from './model';

/** A request line in mono that wraps only after a "/", "?" or "&", never in the middle of a word. */
export function Path({
  text,
  className = '',
}: {
  readonly text: string;
  readonly className?: string;
}) {
  const parts = text.split(/(?<=[/?&])/);
  return (
    <span className={`font-mono [overflow-wrap:anywhere] ${className}`}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i === 0 ? null : <wbr />}
          {p}
        </Fragment>
      ))}
    </span>
  );
}

export function YourDecisions({
  rows,
  chain,
}: {
  readonly rows: readonly DecisionRow[];
  readonly chain: Ledger['chain'] | null;
}) {
  return (
    <Disclosure
      title="Your decisions"
      hint={
        rows.length === 0
          ? 'none yet'
          : `${rows.length} ${rows.length === 1 ? 'decision' : 'decisions'}`
      }
    >
      {rows.length === 0 ? (
        <p className="m-0 py-2 text-[13px] text-muted-foreground">
          No decisions were needed on this audit yet.
        </p>
      ) : (
        <ol className="m-0 list-none p-0">
          {rows.map((r) => (
            <li
              key={r.key}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 border-b border-border py-2.5 text-[13.5px] leading-[21px] sm:grid-cols-[96px_minmax(0,1fr)_auto]"
            >
              <span className="col-span-2 text-[12px] text-muted-foreground sm:col-span-1 sm:text-[12.5px]">
                {r.group}
              </span>
              <span className="flex min-w-0 flex-col break-words">
                {/* What was decided, on what. */}
                <span className="text-foreground">
                  {r.verb}
                  {r.subject === null ? null : r.subject.mono ? (
                    <>
                      {' '}
                      <Path text={r.subject.text} className="text-[12px]" />
                    </>
                  ) : (
                    <> &ldquo;{r.subject.text}&rdquo;</>
                  )}
                  {r.detail === null || r.detail === '' ? null : (
                    <span className="text-muted-foreground"> {r.detail}</span>
                  )}
                </span>
                {/* Why, and by whom: each labelled, so the reason never reads as the subject. */}
                {r.reason === null && r.by === null ? null : (
                  <span className="text-[12.5px] leading-5 text-muted-foreground">
                    {r.reason === null || r.reason === '' ? null : (
                      <>
                        Reason: <span className="text-foreground">&ldquo;{r.reason}&rdquo;</span>
                      </>
                    )}
                    {r.reason !== null && r.reason !== '' && r.by !== null ? ' · ' : null}
                    {r.by === null ? null : `by ${r.by}`}
                  </span>
                )}
              </span>
              {r.at === null ? (
                <span />
              ) : (
                <LocalTime iso={r.at} className="text-[12px] text-muted-foreground" />
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="m-0 mt-1.5 flex items-start gap-1.5 text-[12.5px] leading-5 text-muted-foreground">
        <Icon name="ledger" size={13} className="mt-[3px] shrink-0" />
        {chain === null ? (
          <span>
            Your decisions are also sealed in the ledger. We couldn&rsquo;t check its chain just
            now.
          </span>
        ) : chain.verified ? (
          <span>
            Your decisions are also sealed in the ledger.{' '}
            <NavLink
              href="/ledger#verify"
              className="font-medium text-gold-ink underline-offset-2 hover:underline"
            >
              Chain verified, {chain.count.toLocaleString()}{' '}
              {chain.count === 1 ? 'event' : 'events'}
            </NavLink>
          </span>
        ) : (
          <NavLink
            href="/ledger#verify"
            className="font-medium text-bad underline-offset-2 hover:underline"
          >
            Chain check failed at #{chain.brokenAtSeq}. Open the ledger
          </NavLink>
        )}
      </p>
    </Disclosure>
  );
}

/** "What was not tested and why" (results/model `notTested`): every case that did not run, and what the plan left out. */
export function NotTestedList({ data }: { readonly data: NotTested }) {
  if (data.rows.length === 0 && data.note === null) return null;
  return (
    <Disclosure
      title="What was not tested and why"
      hint={
        data.rows.length === 0
          ? null
          : `${data.rows.length} ${data.rows.length === 1 ? 'item' : 'items'}`
      }
    >
      <ul className="m-0 list-none p-0">
        {data.rows.map((r) => (
          <li
            key={`${r.what}-${r.why}`}
            className="grid gap-x-4 gap-y-0.5 border-b border-border py-2.5 text-[13.5px] leading-[21px] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          >
            <span className="min-w-0 break-words font-medium text-foreground">{r.what}</span>
            <span className="min-w-0 break-words text-muted-foreground">{r.why}</span>
          </li>
        ))}
      </ul>
      {data.note === null ? null : (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="m-0 flex flex-wrap items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
            <VoiceTag voice="claude" />
            What Blackwing says it did not cover · its own words, not verified
          </p>
          <div className="rounded-xl border border-dashed border-border-strong bg-code px-4 py-3 text-[13.5px] leading-[21px] text-foreground">
            <Markdown text={data.note} />
          </div>
        </div>
      )}
      <p className="m-0 mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
        No browser is used, so DOM-based XSS is not tested. The downloaded report lists the same.
      </p>
    </Disclosure>
  );
}
