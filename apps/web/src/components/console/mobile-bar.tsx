'use client';

// Phones (< 768 px, spec §9, bug 14): a 52 px top bar with the menu sheet (the whole sidebar), the brand, a "Your turn"
// pill while anything waits for a decision, and the red Stop icon while an audit runs.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';

import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@blackwing/ui';

import { Icon } from './design';
import { KillButton, type StoppableRun } from './kill-dialog';

export function MobileBar({
  pending,
  run,
  choices,
  children,
}: {
  /** Decisions waiting (Gate 1, 2 and 3). */
  readonly pending: number;
  /** On an audit's own page: that audit. Elsewhere `choices`, the live audits Stop lets the person pick from. */
  readonly run: StoppableRun | null;
  readonly choices: readonly StoppableRun[];
  /** The sidebar content shown in the menu sheet. */
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  // Any navigation from the sheet closes it.
  useEffect(() => {
    setOpen(false);
  }, [path]);
  return (
    <header className="sticky top-0 z-40 flex h-[52px] items-center gap-1 border-b border-border bg-bg pl-1 pr-2 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          className="flex size-11 items-center justify-center rounded-[10px] text-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
          aria-label="Menu"
        >
          <Icon name="menu" size={20} />
        </SheetTrigger>
        <SheetContent
          side="left"
          aria-describedby={undefined}
          className="flex w-[300px] max-w-[85vw] flex-col gap-0 overflow-y-auto border-border bg-sidebar p-0 px-3 pb-3 pt-4"
          onClick={(e) => {
            // A link to the page you are on changes no path: close on the click itself.
            if (e.target instanceof Element && e.target.closest('a') !== null) setOpen(false);
          }}
        >
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {children}
        </SheetContent>
      </Sheet>
      <Link href="/" prefetch={false} className="flex min-w-0 items-center gap-2 px-1 text-foreground no-underline">
        <img src="/brand/crow-shield.png" alt="" width={20} height={20} className="object-contain" />
        <span className="text-[14.5px] font-semibold">Blackwing</span>
      </Link>
      <span className="flex-1" />
      {pending > 0 ? (
        <Link
          href="/decisions"
          prefetch={false}
          title="Decisions waiting for you, across your audits"
          // A 32 px pill with a 44 px hit area (spec §9).
          className="relative inline-flex h-8 items-center gap-1.5 rounded-full bg-gold px-3 text-[12.5px] font-semibold text-on-gold no-underline shadow-[inset_0_0_0_1px_rgba(138,99,16,.28)] before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-['']"
        >
          Your turn
          <span className="tabular-nums">{pending}</span>
        </Link>
      ) : null}
      <KillButton run={run} choices={choices} variant="icon" />
    </header>
  );
}
