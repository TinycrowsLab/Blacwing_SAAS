/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// The console's one navigation (experience spec §2): brand and workspace, New audit, the five places, the Stop pill
// while an audit runs elsewhere, then the live groups (Running, Waiting on you, Drafts, Earlier) and the person.
// Seeded by the layout's server data, refreshed from /api/sidebar every 5 s while visible and at once on `bw:refresh`.
// On phones the same content lives in the MobileBar's sheet. Every control here works; none is decorative.
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@blackwing/ui';

import { Icon, type IconName, Kbd } from './design';
import { Countdown } from './design-client';
import { KillButton, type StoppableRun } from './kill-dialog';
import { MobileBar } from './mobile-bar';
import { useDarkTheme } from './theme-toggle';
import { useNow } from './use-now';
import { signOutAction } from '../../lib/auth-actions';
import { DRAFTS_EVENT, type Draft, draftHref, readDrafts } from '../../lib/drafts';
import { decisionTitle } from '../../lib/plan-text';
import { sidebarSchema, type SidebarData } from '../../lib/schemas';

const POLL_MS = 5000;
const MS_PER_MINUTE = 60_000;

export interface SidebarViewer {
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
}

interface NavItem {
  readonly label: string;
  readonly icon: IconName;
  readonly href: string;
  /** Path prefixes that make it current (the new route and, while pages move, the old one). */
  readonly match: readonly string[];
}

const NAV: readonly NavItem[] = [
  { label: 'Home', icon: 'home', href: '/', match: [] },
  { label: 'Decisions', icon: 'approve', href: '/decisions', match: ['/decisions', '/approvals'] },
  { label: 'Targets', icon: 'host', href: '/targets', match: ['/targets', '/assets'] },
  { label: 'Findings', icon: 'findings', href: '/findings', match: ['/findings'] },
  { label: 'Ledger', icon: 'ledger', href: '/ledger', match: ['/ledger', '/audit'] },
];

const isCurrent = (item: NavItem, path: string): boolean =>
  item.href === '/' ? path === '/' : item.match.some((m) => path === m || path.startsWith(`${m}/`));

/** True while typing: single-key shortcuts must not fire then. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

type LiveRun = SidebarData['live'][number];

const stoppable = (r: LiveRun, actorId: string | null): StoppableRun => ({
  id: r.id,
  assetName: r.assetName ?? 'this audit',
  startedAt: r.startedAt,
  startedBy: r.startedBy?.name ?? null,
  mine: actorId !== null && r.startedBy?.id === actorId,
});

/**
 * What Stop acts on (button, Ctrl+Shift+. and the phone's red icon). On an audit's own page: that audit, or nothing once
 * it ended (never another audit behind the one on screen). Elsewhere nothing is preselected: Stop lists the live
 * audits, with who started each and when, and the person picks. Exported for the unit test.
 */
export function stopTarget(
  data: Pick<SidebarData, 'live' | 'actorId'> | null,
  path: string,
): { readonly run: StoppableRun | null; readonly choices: readonly StoppableRun[]; readonly onRunPage: boolean } {
  const live = data?.live ?? [];
  const actorId = data?.actorId ?? null;
  const onRun = /^\/runs\/([^/]+)/.exec(path)?.[1];
  if (onRun !== undefined) {
    const here = live.find((r) => r.id === decodeURIComponent(onRun));
    return { run: here === undefined ? null : stoppable(here, actorId), choices: [], onRunPage: true };
  }
  return { run: null, choices: live.map((r) => stoppable(r, actorId)), onRunPage: false };
}

/** What waits on people: exact when the API counts it, else what the (capped) lists hold. */
export function waitingCount(data: SidebarData | null): number {
  if (data === null) return 0;
  const listed = data.gate2.length + data.plans.length + data.releases.length;
  return data.counts === null ? listed : Math.max(listed, data.counts.gate1 + data.counts.gate2 + data.counts.gate3);
}

/**
 * How "Waiting on you" stays short: each Gate 2 request and plan is a row, proven findings fold into one row with their
 * count (exact when the API counts them), and what the lists leave out is one "more on Decisions" line.
 */
export function waitingRows(data: SidebarData): { readonly findings: number; readonly more: number } {
  const findings = Math.max(data.releases.length, data.counts?.gate3 ?? 0);
  const asks = data.counts === null ? 0 : data.counts.gate1 + data.counts.gate2;
  return { findings, more: Math.max(0, asks - data.gate2.length - data.plans.length) };
}

/** The dot of a finished audit: green when it completed, red when it was stopped or failed. */
export function outcomeDot(state: string): 'ok' | 'bad' | 'faint' {
  if (state === 'completed') return 'ok';
  return state === 'killed' || state === 'failed' ? 'bad' : 'faint';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
}

/** Keeps the sidebar data fresh: poll while visible, on `bw:refresh`, on return to the tab and on navigation. */
function useSidebarData(initial: SidebarData | null): {
  data: SidebarData | null;
  failed: boolean;
  refresh: () => void;
} {
  const [data, setData] = useState(initial);
  const [failed, setFailed] = useState(false);
  const path = usePathname();
  const refresh = useCallback(() => {
    void (async () => {
      try {
        const res = await fetch('/api/sidebar', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        setData(sidebarSchema.parse(await res.json()));
        setFailed(false);
      } catch {
        // Keep the last data; say so quietly.
        setFailed(true);
      }
    })();
  }, []);
  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    const timer = window.setInterval(tick, POLL_MS);
    window.addEventListener('bw:refresh', refresh);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('bw:refresh', refresh);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);
  useEffect(() => {
    refresh();
  }, [path, refresh]);
  return { data, failed, refresh };
}

function useDrafts(): Draft[] {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  useEffect(() => {
    const load = (): void => {
      setDrafts(readDrafts());
    };
    load();
    window.addEventListener(DRAFTS_EVENT, load);
    window.addEventListener('storage', load);
    return () => {
      window.removeEventListener(DRAFTS_EVENT, load);
      window.removeEventListener('storage', load);
    };
  }, []);
  return drafts;
}

/** "(1) Decision needed · " in front of the tab title while a Gate 2 decision waits (Next rewrites the title on navigation). */
function useTitlePrefix(waiting: number): void {
  useEffect(() => {
    const prefix = /^\(\d+\) Decision needed · /;
    const apply = (): void => {
      const base = document.title.replace(prefix, '');
      const next = waiting > 0 ? `(${waiting}) Decision needed · ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = document.title.replace(prefix, '');
    };
  }, [waiting]);
}

function Row({
  href,
  title,
  sub,
  dot,
  current = false,
}: {
  readonly href: string;
  readonly title: string;
  readonly sub: React.ReactNode;
  readonly dot: 'gold' | 'live' | 'ok' | 'bad' | 'faint';
  readonly current?: boolean;
}) {
  const dots = {
    gold: 'bg-gold motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]',
    live: 'bg-gold-ink motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]',
    ok: 'bg-ok',
    bad: 'bg-bad',
    faint: 'bg-faint',
  };
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={current ? 'page' : undefined}
      className={`grid grid-cols-[14px_minmax(0,1fr)] gap-x-2 rounded-[9px] px-2.5 py-2 text-foreground no-underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${current ? 'bg-card shadow-[inset_0_0_0_1px_var(--border)]' : 'hover:bg-surface-2'}`}
    >
      <span aria-hidden="true" className={`mt-[7px] size-[7px] rounded-full ${dots[dot]}`} />
      <span className="truncate text-[13px] font-medium">{title}</span>
      <span className="col-start-2 truncate text-[11.5px] text-muted-foreground">{sub}</span>
    </Link>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-px">
      <h2 className="m-0 px-2.5 pb-1.5 pt-4 text-[11.5px] font-medium tracking-[0.02em] text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function UserMenu({ viewer }: { readonly viewer: SidebarViewer }) {
  const [dark, toggleTheme] = useDarkTheme();
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2.5 rounded-[10px] px-2 py-2 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        aria-label="Account and settings"
      >
        {viewer.image === null ? (
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-text text-xs font-semibold text-bg"
          >
            {initials(viewer.name)}
          </span>
        ) : (
          <img
            src={viewer.image}
            alt=""
            width={32}
            height={32}
            referrerPolicy="no-referrer"
            className="size-8 shrink-0 rounded-full object-cover"
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium leading-[17px] text-foreground">{viewer.name}</span>
          <span className="truncate text-[11.5px] text-muted-foreground">{viewer.email}</span>
        </span>
        <Icon name="settings" size={16} className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-[240px]">
        <DropdownMenuLabel className="truncate font-normal">{viewer.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2.5"
          onSelect={() => {
            router.push('/settings');
          }}
        >
          <Icon name="settings" size={15} />
          Workspace settings
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5" onSelect={toggleTheme}>
          <Icon name={dark ? 'sun' : 'moon'} size={15} />
          {dark ? 'Light theme' : 'Dark theme'}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="gap-2.5"
          onSelect={() => {
            router.push('/help');
          }}
        >
          <Icon name="help" size={15} />
          Help
          <Kbd className="ml-auto">?</Kbd>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="gap-2.5"
          onSelect={() => {
            void signOutAction();
          }}
        >
          <Icon name="arrowLeft" size={15} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarBody({
  data,
  failed,
  refresh,
  workspaceName,
  viewer,
  inSheet = false,
}: {
  readonly data: SidebarData | null;
  readonly failed: boolean;
  readonly refresh: () => void;
  readonly workspaceName: string | null;
  readonly viewer: SidebarViewer;
  /** In the phone menu sheet the top bar already carries Stop, so the pill is left out. */
  readonly inSheet?: boolean;
}) {
  const path = usePathname();
  const now = useNow(true, 30_000);
  const drafts = useDrafts();
  const router = useRouter();
  const decisions = waitingCount(data);
  const waiting = data === null ? null : waitingRows(data);
  const live = data?.live ?? [];
  const stop = stopTarget(data, path);
  const name = data?.workspaceName ?? workspaceName;
  const empty =
    data !== null &&
    decisions === 0 &&
    live.length === 0 &&
    data.earlier.length === 0 &&
    drafts.length === 0;

  const runSub = (r: SidebarData['live'][number]): string => {
    if (r.state === 'queued') return 'Queued';
    if (r.paused || r.state === 'paused') return 'Paused';
    const since = r.startedAt === null || now === 0 ? null : Math.max(0, Math.floor((now - Date.parse(r.startedAt)) / MS_PER_MINUTE));
    return since === null ? 'Testing' : `Testing · ${since < 1 ? 'just started' : `${since} min in`}`;
  };
  const earlierSub = (r: SidebarData['earlier'][number]): string => {
    const at = r.finishedAt ?? r.createdAt;
    // The reader's locale only after mount (`now` is 0 on the server and at hydration): no hydration mismatch.
    const when = now === 0 ? at.slice(0, 10) : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at));
    const word = r.state === 'completed' ? 'Finished' : r.state === 'killed' ? 'Stopped' : r.state === 'failed' ? 'Stopped with an error' : r.state;
    return `${word} · ${when}`;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2.5 px-2 pb-3.5 pr-10 md:pr-2">
        <Link href="/" className="flex shrink-0 items-center gap-2.5 text-foreground no-underline">
          <img src="/brand/crow-shield.png" alt="" width={24} height={24} className="object-contain" />
          <span className="text-[16px] font-semibold tracking-[-0.01em]">Blackwing</span>
        </Link>
        {name === null ? null : (
          <span className="ml-auto truncate text-[12.5px] text-muted-foreground" title={name}>
            {name}
          </span>
        )}
      </div>
      <Link
        href="/audits/new"
        className="mb-2 flex h-[42px] items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 text-[13.5px] font-medium text-foreground no-underline hover:border-gold-line hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
      >
        <Icon name="plus" size={16} />
        New audit
        {inSheet ? null : <Kbd className="ml-auto text-muted-foreground">N</Kbd>}
      </Link>
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV.map((item) => {
          const current = isCurrent(item, path);
          return (
            <Link
              key={item.href}
              href={item.href}
              // Each prefetch renders a page on the server: only the place the pointer or focus is about to open.
              prefetch={false}
              onMouseEnter={() => {
                router.prefetch(item.href);
              }}
              onFocus={() => {
                router.prefetch(item.href);
              }}
              aria-current={current ? 'page' : undefined}
              className={`flex h-[38px] items-center gap-[11px] rounded-[9px] px-2.5 text-[13.5px] text-foreground no-underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${current ? 'bg-gold-soft font-medium' : 'hover:bg-surface-2'}`}
            >
              <Icon name={item.icon} size={17} className={current ? 'text-gold-ink' : 'text-muted-foreground'} />
              {item.label}
              {item.href === '/decisions' && decisions > 0 ? (
                <span className="ml-auto flex h-5 min-w-[22px] items-center justify-center rounded-full bg-gold px-1.5 text-[11px] font-semibold text-on-gold">
                  {decisions}
                  <span className="sr-only"> waiting for you</span>
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      {inSheet ? null : (
        // Stays mounted when the run ends, so the open dialog can show the halt it measured.
        <div className={stop.choices.length === 0 ? 'contents' : 'mt-3'}>
          <KillButton
            run={stop.run}
            choices={stop.choices}
            variant="pill"
            label={`${live.length} ${live.length === 1 ? 'audit' : 'audits'} running`}
            shortcut
            hideTrigger={stop.onRunPage}
          />
        </div>
      )}
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-2 [scrollbar-color:var(--border2)_transparent] [scrollbar-width:thin]">
        {data === null ? (
          <p className="m-0 px-2.5 pt-4 text-[12.5px] leading-5 text-muted-foreground">
            Couldn&apos;t load your audits.{' '}
            <button type="button" onClick={refresh} className="font-medium text-gold-ink underline">
              Retry
            </button>
          </p>
        ) : null}
        {live.length === 0 ? null : (
          <Section title="Running">
            {live.map((r) => (
              <Row
                key={r.id}
                href={`/runs/${r.id}`}
                current={path.startsWith(`/runs/${r.id}`)}
                dot="live"
                title={r.assetName ?? 'Audit'}
                sub={runSub(r)}
              />
            ))}
          </Section>
        )}
        {data !== null && waiting !== null && decisions > 0 ? (
          <Section title="Waiting on you">
            {data.gate2.map((g) => (
              <Row
                key={g.id}
                href={`/decisions/gate2/${g.id}`}
                current={path === `/decisions/gate2/${g.id}`}
                dot="gold"
                title={decisionTitle(g.method, g.url)}
                sub={
                  <>
                    {hostOf(g.url)} · <Countdown deadlineAt={g.deadlineAt} {...(g.createdAt === undefined ? {} : { createdAt: g.createdAt })} />
                  </>
                }
              />
            ))}
            {data.plans.map((p) => (
              <Row
                key={p.id}
                href={`/audits/${p.id}`}
                current={path === `/audits/${p.id}`}
                dot="gold"
                title={p.assetName}
                sub="Plan ready for your approval"
              />
            ))}
            {waiting.findings === 0 ? null : (
              <Row
                href="/findings?status=confirmed"
                dot="gold"
                title={`${waiting.findings.toLocaleString()} proven ${waiting.findings === 1 ? 'finding' : 'findings'} to review`}
                sub="Release or dismiss"
              />
            )}
            {waiting.more > 0 ? (
              <Link
                href="/decisions"
                prefetch={false}
                className="rounded-[9px] px-2.5 py-1.5 pl-[30px] text-[12px] font-medium text-gold-ink no-underline hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
              >
                And {waiting.more.toLocaleString()} more on Decisions
              </Link>
            ) : null}
          </Section>
        ) : null}
        {drafts.length === 0 ? null : (
          <Section title="Drafts">
            {drafts.map((d) => (
              <Row key={d.id} href={draftHref(d)} dot="faint" title={d.host} sub={`Draft · question ${d.step} of 4`} />
            ))}
          </Section>
        )}
        {data === null || data.earlier.length === 0 ? null : (
          <Section title="Earlier">
            {data.earlier.map((r) => (
              <Row
                key={r.id}
                href={`/runs/${r.id}`}
                current={path.startsWith(`/runs/${r.id}`)}
                dot={outcomeDot(r.state)}
                title={r.assetName ?? 'Audit'}
                sub={earlierSub(r)}
              />
            ))}
          </Section>
        )}
        {empty ? (
          <Section title="Audits">
            <p className="m-0 px-2.5 text-[12.5px] leading-5 text-muted-foreground">
              Your audits will appear here. Anything that needs you comes first.
            </p>
          </Section>
        ) : null}
        {failed && data !== null ? (
          <p className="m-0 px-2.5 pt-3 text-[11.5px] text-muted-foreground">
            Couldn&apos;t refresh.{' '}
            <button type="button" onClick={refresh} className="font-medium text-gold-ink underline">
              Retry
            </button>
          </p>
        ) : null}
      </div>
      <div className="border-t border-border pt-2">
        <Link
          href="/help"
          prefetch={false}
          className="mb-1 flex h-8 items-center gap-2.5 rounded-[9px] px-2.5 text-[12.5px] text-muted-foreground no-underline hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          <Icon name="help" size={15} />
          How this works
          {inSheet ? null : <Kbd className="ml-auto">?</Kbd>}
        </Link>
        <UserMenu viewer={viewer} />
      </div>
    </div>
  );
}

/** The desktop sidebar and the phone top bar, sharing one data source. */
export function ConsoleSidebar({
  initial,
  workspaceName,
  viewer,
}: {
  readonly initial: SidebarData | null;
  readonly workspaceName: string | null;
  readonly viewer: SidebarViewer;
}) {
  const { data, failed, refresh } = useSidebarData(initial);
  const router = useRouter();
  const path = usePathname();
  useTitlePrefix(data === null ? 0 : Math.max(data.gate2.length, data.counts?.gate2 ?? 0));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      // Not while a dialog or an inline editor has focus: the key belongs to it.
      if (e.target instanceof Element && e.target.closest('[role="dialog"], [data-no-shortcuts]') !== null) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        router.push('/audits/new');
      } else if (e.key === '?') {
        e.preventDefault();
        router.push('/help');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [router]);

  const props = { data, failed, refresh, workspaceName, viewer };
  const stop = stopTarget(data, path);
  return (
    <>
      <MobileBar pending={waitingCount(data)} run={stop.run} choices={stop.choices}>
        <SidebarBody {...props} inSheet />
      </MobileBar>
      <aside
        aria-label="Sidebar"
        className="sticky top-0 hidden h-dvh flex-col border-r border-border bg-sidebar px-3 pb-3 pt-4 md:flex"
      >
        <SidebarBody {...props} />
      </aside>
    </>
  );
}
