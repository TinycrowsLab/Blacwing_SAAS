/* Presentational values (pixel sizes, opacity steps, poll and tick intervals) come from design/ and are not domain constants. */

// DEMO-STORY shell: the layout grammar of design/ (top bar 56 px, 64 px icon rail, breadcrumb header, status chips,
// authorisation strip, right-hand context panel). Demo chrome only; every demo page renders inside it.
import Link from 'next/link';

import { DemoRail } from './demo-rail';
import { Icon } from './design';
import { KillButton } from './kill-dialog';
import { SignOutButton } from './sign-out-button';
import { ThemeToggle } from './theme-toggle';

import type { ReactNode } from 'react';

export interface DemoShellProps {
  readonly name: string;
  readonly roles: readonly string[];
  /** Gate 2 requests waiting for a decision, and the first one's page. */
  readonly pendingGate2: number;
  readonly firstGate2Id: string | null;
  /** The most recent running run, the target of the top bar Kill button. */
  readonly runningRun: { readonly id: string; readonly assetName: string } | null;
  readonly children: ReactNode;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
}

/** The crow-shield mark and the wordmark. The shield is the product mark; the tinycrows lockup is in the footer. */
export function BrandMark({ size = 26 }: { readonly size?: number }) {
  return (
    <img
      src="/brand/crow-shield.png"
      alt=""
      width={size}
      height={size}
      className="object-contain"
    />
  );
}

export function DemoShell({
  name,
  roles,
  pendingGate2,
  firstGate2Id,
  runningRun,
  children,
}: DemoShellProps) {
  return (
    <div className="demo-canvas min-h-screen bg-bg text-text">
      <header className="flex h-14 items-center gap-2 border-b border-border bg-surface px-3 sm:gap-4 sm:px-5">
        <Link href="/demo" className="flex items-center gap-2.5 text-foreground no-underline">
          <BrandMark />
          <span className="text-base font-semibold">Blackwing</span>
        </Link>
        <span className="hidden h-8 items-center gap-2 rounded-full bg-surface-2 px-3 text-[13px] font-medium sm:inline-flex">
          Acme Corp
          <Icon name="chevron" size={13} />
        </span>
        <span className="relative hidden h-9 max-w-[460px] flex-1 items-center gap-2.5 rounded-[10px] bg-surface-2 px-3 text-[13px] text-muted-foreground md:inline-flex">
          <Icon name="search" size={15} />
          <span className="flex-1">Search assets, runs, findings</span>
          <kbd className="rounded-[5px] border border-border-strong px-1.5 py-px text-[11px] font-medium">
            Ctrl K
          </kbd>
        </span>
        <div className="flex-1" />
        <ThemeToggle />
        <Link
          href={firstGate2Id === null ? '/demo' : `/demo/approvals/gate2/${firstGate2Id}`}
          title={`${pendingGate2} Gate 2 decisions waiting`}
          className="relative flex size-9 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-surface-2"
        >
          <Icon name="bell" size={19} />
          {pendingGate2 > 0 ? (
            <span className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-warn text-[10px] font-semibold text-white">
              {pendingGate2}
            </span>
          ) : null}
          <span className="sr-only">{pendingGate2} Gate 2 decisions waiting</span>
        </Link>
        <KillButton run={runningRun} />
        <span
          className="flex items-center gap-2.5"
          data-testid="demo-user"
          title={`${name}: ${roles.join(', ') || 'no roles'}`}
        >
          <span
            aria-hidden="true"
            className="flex size-[34px] items-center justify-center rounded-full bg-primary text-xs font-semibold text-on-primary"
          >
            {initials(name)}
          </span>
          <span className="sr-only">{name}</span>
        </span>
        <SignOutButton />
      </header>
      <div className="grid min-h-[calc(100vh-3.5rem)] grid-cols-1 md:grid-cols-[64px_minmax(0,1fr)]">
        <DemoRail pendingGate2={pendingGate2} />
        <main className="min-w-0 space-y-3 px-4 py-5 sm:px-7">{children}</main>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-7 py-3 text-[11.5px] text-muted-foreground">
        <span>Blackwing demo. Agent output is labelled not verified.</span>
        <Link href="/demo/about" className="text-muted-foreground underline hover:text-foreground">
          What is real, what is a stub
        </Link>
      </footer>
    </div>
  );
}

/** Right-hand context panel (design 1b): what the screen is for, who sees it, what is audited. */
export function ContextPanel({
  sections,
}: {
  readonly sections: readonly { title: string; body: string }[];
}) {
  return (
    <aside
      aria-label="Context"
      className="flex w-full flex-col gap-4 text-[12.5px] leading-5 text-muted-foreground xl:w-[240px]"
    >
      {sections.map((s) => (
        <div key={s.title} className="flex flex-col gap-1">
          <h2 className="text-[13px] font-semibold text-foreground">{s.title}</h2>
          <p className="m-0">{s.body}</p>
        </div>
      ))}
    </aside>
  );
}
