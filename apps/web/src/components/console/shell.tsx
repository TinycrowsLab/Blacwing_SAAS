// Console shell (experience spec §2): a Claude-app layout, the 264 px sidebar and one main column; under 768 px a 52 px
// top bar with the menu sheet. No search, no bell, no workspace switcher: every control works or is not rendered.
import { ConsoleSidebar, type SidebarViewer } from './sidebar';

import type { SidebarData } from '../../lib/schemas';
import type { ReactNode } from 'react';

export interface ShellProps {
  readonly viewer: SidebarViewer;
  /** Null until named on /welcome (or when the API did not answer). */
  readonly workspaceName: string | null;
  /** The sidebar's first data, from the layout; null when the API did not answer (the sidebar says so and retries). */
  readonly sidebar: SidebarData | null;
  readonly children: ReactNode;
}

export function Shell({ viewer, workspaceName, sidebar, children }: ShellProps) {
  return (
    <div className="min-h-dvh bg-bg text-text md:grid md:grid-cols-[264px_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-gold px-3 py-2 text-on-gold focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <ConsoleSidebar initial={sidebar} workspaceName={workspaceName} viewer={viewer} />
      <main id="main" className="min-w-0 space-y-3 px-4 py-5 sm:px-6 md:px-8 md:py-7">
        {children}
      </main>
    </div>
  );
}

/** Right-hand context panel: what the screen is for, who sees it, what is audited. */
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
