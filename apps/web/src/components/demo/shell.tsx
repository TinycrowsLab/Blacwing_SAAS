/* Presentational values (pixel sizes, opacity steps, poll and tick intervals) come from design/ and are not domain constants. */

// DEMO-STORY shell: the layout grammar of design/ (top bar 56 px, 64 px icon rail, breadcrumb header, status chips,
// authorisation strip, right-hand context panel). Demo chrome only; every demo page renders inside it.
import Link from 'next/link';

import { ModeToggle } from '@blackwing/ui';

import { DemoRail } from './demo-rail';
import { Icon, LinkButton } from './design';
import { SignOutButton } from './sign-out-button';

import type { ReactNode } from 'react';

export interface DemoShellProps {
  readonly name: string;
  readonly roles: readonly string[];
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

export function DemoShell({ name, roles, children }: DemoShellProps) {
  return (
    <div className="min-h-screen bg-bg text-text">
      <div className="border-b border-border bg-warn-soft px-4 py-1 text-center text-xs font-medium text-warn">
        Demo mode. Lab target only (local Juice Shop). Localhost development build, not production.
      </div>
      <header className="flex h-14 items-center gap-4 border-b border-border bg-surface px-5">
        <Link href="/demo" className="flex items-center gap-2.5 text-foreground no-underline">
          <BrandMark />
          <span className="text-base font-semibold">Blackwing</span>
        </Link>
        <span className="inline-flex h-8 items-center gap-2 rounded-full bg-surface-2 px-3 text-[13px] font-medium">
          Acme Corp
        </span>
        <span className="relative hidden h-9 max-w-[460px] flex-1 items-center gap-2.5 rounded-[10px] bg-surface-2 px-3 text-[13px] text-muted-foreground md:inline-flex">
          <Icon name="search" size={15} />
          <span className="flex-1">Search assets, runs, findings</span>
          <kbd className="rounded-[5px] border border-border-strong px-1.5 py-px text-[11px] font-medium">
            Ctrl K
          </kbd>
        </span>
        <div className="flex-1" />
        <Chip>Demo, lab target</Chip>
        <ModeToggle />
        <span
          className="flex items-center gap-2.5"
          data-testid="demo-user"
          title={roles.join(', ') || 'no roles'}
        >
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-on-primary"
          >
            {initials(name)}
          </span>
          <span className="hidden text-[13px] font-medium lg:inline">{name}</span>
        </span>
        <SignOutButton />
      </header>
      <div className="grid min-h-[calc(100vh-5.5rem)] grid-cols-[64px_minmax(0,1fr)]">
        <DemoRail />
        <main className="min-w-0 space-y-6 px-7 py-6">{children}</main>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-7 py-3 text-xs text-muted-foreground">
        <span>Blackwing demo. Agent output is labelled not verified.</span>
        <LinkButton href="/demo/about" variant="ghost">
          What is real, what is stubbed
        </LinkButton>
      </footer>
    </div>
  );
}

function Chip({ children }: { readonly children: ReactNode }) {
  return (
    <span className="hidden h-7 items-center rounded-md bg-surface-2 px-2.5 text-xs font-medium text-muted-foreground md:inline-flex">
      {children}
    </span>
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
      className="flex w-full flex-col gap-4 text-[12.5px] leading-5 text-muted-foreground xl:w-[260px]"
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
