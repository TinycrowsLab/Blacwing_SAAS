'use client';

// "Your audit" (experience spec §3.3): the ticket fills in as the person answers; the current line is gold. The
// optional details show their prefilled values, changed on the plan. On phones it is a pill that opens a sheet.
import { useState } from 'react';

import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@blackwing/ui';

import { Icon } from '../design';

export interface TicketLine {
  readonly label: string;
  /** Null while unanswered: the line then says when it is asked. */
  readonly value: string | null;
}

export interface TicketDetail {
  readonly label: string;
  readonly value: string;
  readonly tag: 'Default' | 'Suggested';
}

function TicketBody({
  lines,
  current,
  details,
  saved,
  inSheet = false,
}: {
  readonly lines: readonly TicketLine[];
  readonly current: number;
  readonly details: readonly TicketDetail[];
  readonly saved: boolean;
  /** In the phone sheet the close button sits top right: the header keeps clear of it. */
  readonly inSheet?: boolean;
}) {
  return (
    <>
      <div className={`flex items-center justify-between pb-2 pl-5 pt-5 ${inSheet ? 'pr-14' : 'pr-5'}`}>
        <h2 className="m-0 text-[16px] font-semibold text-foreground">Your audit</h2>
        <span aria-live="polite" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
          {saved ? (
            <>
              <Icon name="check" size={12} />
              Draft saved
            </>
          ) : null}
        </span>
      </div>
      <ol className="m-0 flex list-none flex-col p-0">
        {lines.map((l, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'next';
          return (
            <li
              key={l.label}
              aria-current={state === 'current' ? 'step' : undefined}
              className={`flex gap-3 px-5 py-2.5 ${state === 'current' ? 'bg-gold-soft' : ''}`}
            >
              <span
                aria-hidden="true"
                className={`mt-[5px] size-2.5 shrink-0 rounded-full ${state === 'done' ? 'bg-ok' : state === 'current' ? 'bg-gold shadow-[inset_0_0_0_1px_rgba(138,99,16,.4)]' : 'border border-border-strong'}`}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-[12.5px] text-muted-foreground">{l.label}</span>
                <span
                  className={`break-words text-[13.5px] ${l.value === null ? 'text-muted-foreground' : 'font-medium text-foreground'}`}
                >
                  {l.value ?? (state === 'current' ? 'This question' : i === current + 1 ? 'Next question' : 'After that')}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mx-5 mt-2 border-t border-dashed border-border-strong pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="m-0 text-[13px] font-semibold text-foreground">Optional details</h3>
          <span className="text-[12px] text-muted-foreground">change on the plan</span>
        </div>
        <dl className="m-0 flex flex-col gap-2">
          {details.map((d) => (
            <div key={d.label} className="flex items-center justify-between gap-3 text-[12.5px]">
              <dt className="text-muted-foreground">{d.label}</dt>
              <dd className="m-0 flex items-center gap-2 text-right text-foreground">
                {d.value}
                <span className="inline-flex h-[18px] items-center rounded-[5px] bg-surface-2 px-1.5 text-[10.5px] font-semibold text-muted-foreground">
                  {d.tag}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="m-0 px-5 pb-5 pt-3 text-[12px] leading-[18px] text-muted-foreground">
        Then I&apos;ll read the whole plan back to you. No test traffic reaches the site before you approve it.
      </p>
    </>
  );
}

export function Ticket(props: {
  readonly lines: readonly TicketLine[];
  readonly current: number;
  readonly details: readonly TicketDetail[];
  readonly saved: boolean;
}) {
  return (
    <aside aria-label="Your audit" className="hidden overflow-hidden rounded-[18px] border border-border bg-card lg:block">
      <TicketBody {...props} />
    </aside>
  );
}

/** Phones: "Your audit" pill that opens the ticket as a bottom sheet. */
export function TicketPill(props: {
  readonly lines: readonly TicketLine[];
  readonly current: number;
  readonly details: readonly TicketDetail[];
  readonly saved: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger className="inline-flex h-9 shrink-0 items-center whitespace-nowrap gap-1.5 rounded-full border border-border bg-card px-3.5 text-[12.5px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus lg:hidden">
        <Icon name="file" size={14} />
        Your audit
      </SheetTrigger>
      <SheetContent
        side="bottom"
        aria-describedby={undefined}
        className="max-h-[85dvh] overflow-y-auto rounded-t-[18px] border-border bg-card p-0"
      >
        <SheetTitle className="sr-only">Your audit</SheetTitle>
        <TicketBody {...props} inSheet />
      </SheetContent>
    </Sheet>
  );
}
