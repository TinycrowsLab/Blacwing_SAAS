/* eslint-disable @typescript-eslint/no-magic-numbers -- display truncation (hashes) */
// Ledger (experience spec §2, §8): every decision in the workspace, newest first, hash-chained. The API re-verifies
// the whole chain on each load; the pill says what it found.

import { z } from 'zod';

import { ledgerWords } from './words';
import { Chip, EmptyState, Icon } from '../../../components/console/design';
import { Path } from '../../../components/console/results/decisions';
import { HashFocus } from '../../../components/console/results/hash-focus';
import { HIGHLIGHT_CLASS } from '../../../components/console/results/highlight';
import { readApi } from '../../../components/console/results/load';
import { LocalTime } from '../../../components/console/results/local-time';
import {
  actionLabel,
  ledgerSchema,
  PLAN_REPLACED_REASON,
  type LedgerItem,
} from '../../../components/console/results/model';
import { NavLink } from '../../../components/console/results/nav-link';
import { RefreshButton } from '../../../components/console/results/settings-form';
import { getViewer } from '../../../lib/auth';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Ledger' };

const TARGET: Readonly<Record<string, { href: (id: string) => string; label: string }>> = {
  request: { href: (id) => `/audits/${id}`, label: 'View audit' },
  run: { href: (id) => `/runs/${id}`, label: 'View audit' },
  finding: { href: (id) => `/findings/${id}`, label: 'View finding' },
  gate2: { href: (id) => `/decisions/gate2/${id}`, label: 'View request' },
  asset: { href: () => '/targets', label: 'View targets' },
};
/** Newest entries shown at first; "Show all" lists the rest. */
const PAGE = 50;

const findingTitles = z.object({ items: z.array(z.object({ id: z.string(), title: z.string() })) });

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
/** "Approved a plan" reads "· approved a plan" after the name; an origin or a run id keeps its case. */
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** The one line of context an entry carries: the request it allowed, the name it set, the reason given. */
function Detail({
  item,
  title,
  previousName,
}: {
  readonly item: LedgerItem;
  readonly title: string | undefined;
  /** The name before this one, when this entry renamed the workspace. */
  readonly previousName: string | undefined;
}) {
  const p = item.payload;
  // These words already hold their detail.
  if (ledgerWords(item.action, p, item.targetId) !== null) return null;
  const method = text(p.method);
  const url = text(p.url);
  const name = text(p.name);
  // A replaced draft already reads as "edited a plan"; its stock reason would only repeat that.
  const reason = text(p.reason) === PLAN_REPLACED_REASON ? null : text(p.reason);
  return (
    <span className="text-muted-foreground">
      {method !== null && url !== null ? (
        <>
          {' '}
          <Path text={`${method.toUpperCase()} ${pathOf(url)}`} className="text-[12px]" />
        </>
      ) : null}
      {item.action === 'workspace.named' && name !== null ? (
        previousName === undefined ? (
          <> &ldquo;{name}&rdquo;</>
        ) : (
          <>
            {' '}
            from &ldquo;{previousName}&rdquo; to{' '}
            <span className="text-foreground">&ldquo;{name}&rdquo;</span>
          </>
        )
      ) : null}
      {title === undefined ? null : <span className="text-foreground"> &ldquo;{title}&rdquo;</span>}
      {reason === null ? null : <> &ldquo;{reason}&rdquo;</>}
    </span>
  );
}

export default async function LedgerPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const all = (await searchParams).all !== undefined;
  // The ledger stores ids; the findings list names them. Without it the entries still read, just unnamed.
  const [{ items, chain }, findings] = await Promise.all([
    readApi('/audit').then((b) => ledgerSchema.parse(b)),
    readApi('/findings')
      .then((b) => findingTitles.parse(b).items)
      .catch(() => []),
  ]);
  const titles = new Map(findings.map((f) => [f.id, f.title]));
  // Each naming after the first is a rename: walk the entries oldest first and remember the name it replaced.
  const renamedFrom = new Map<string, string>();
  let lastName: string | null = null;
  for (const e of [...items].reverse())
    if (e.action === 'workspace.named') {
      const name = text(e.payload.name);
      if (lastName !== null && name !== null) renamedFrom.set(e.eventId, lastName);
      lastName = name ?? lastName;
    }
  const checkedAt = new Date().toISOString();
  const head = items[0]?.hash ?? null;
  const shown = all ? items : items.slice(0, PAGE);
  // Naming the workspace is always entry #1, so "nothing else yet" is the real first-run state of the ledger.
  const onlySetup = items.every((e) => e.action === 'workspace.named');
  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5">
      <HashFocus />
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground">
            Ledger
          </h1>
          {items.length === 0 ? null : chain.verified ? (
            <Chip tone="ok" icon="check" pill>
              Chain verified
            </Chip>
          ) : (
            <Chip tone="bad" icon="x" pill bordered>
              Chain check failed at #{chain.brokenAtSeq}
            </Chip>
          )}
        </div>
        <p className="m-0 max-w-[68ch] text-[14px] leading-[22px] text-muted-foreground">
          Every decision made in this workspace, newest first. Each entry&rsquo;s fingerprint covers
          the one before it, so changing or removing any entry breaks the chain, and the check below
          fails.
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon="ledger"
          title="The ledger starts with your first action."
          body="Approving a plan, deciding on a request, releasing a finding or stopping an audit each adds an entry here."
        />
      ) : (
        <>
          <section
            id="verify"
            aria-label="Chain check"
            className={`flex scroll-mt-6 flex-wrap items-start gap-3 rounded-[14px] border px-4 py-3.5 ${chain.verified ? 'border-border bg-card' : 'border-bad bg-bad-soft'} ${HIGHLIGHT_CLASS}`}
          >
            <span
              className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] ${chain.verified ? 'bg-ok-soft text-ok' : 'bg-card text-bad'}`}
            >
              <Icon name={chain.verified ? 'shield' : 'warn'} size={17} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13.5px] leading-5">
              <span className="font-semibold text-foreground">
                {chain.verified
                  ? chain.count === 1
                    ? 'Chain verified: 1 entry, sealed.'
                    : `Chain verified: all ${chain.count.toLocaleString()} entries link up.`
                  : `Chain check failed at entry #${chain.brokenAtSeq}. Entries from there on cannot be trusted.`}
              </span>
              <span className="text-muted-foreground">
                {head === null ? null : (
                  <>
                    Newest fingerprint{' '}
                    <span
                      className="font-mono text-[12px] text-foreground"
                      title={`sha256 ${head}`}
                    >
                      {head.slice(0, 8)}…{head.slice(-4)}
                    </span>
                  </>
                )}
                {/* Re-checked on every load and on "Check again"; the time says which check this is. */}
                <LocalTime
                  iso={checkedAt}
                  prefix={head === null ? 'Checked at ' : ' · checked at '}
                />
              </span>
            </div>
            <RefreshButton
              label="Check again"
              busyLabel="Checking…"
              className="h-9 shrink-0 rounded-[10px] border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus disabled:cursor-progress disabled:text-muted-foreground"
            />
          </section>

          <ol className="m-0 flex list-none flex-col overflow-hidden rounded-[14px] border border-border bg-card p-0">
            {shown.map((e) => {
              const target = TARGET[e.targetType];
              return (
                <li
                  key={e.eventId}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[132px_minmax(0,1fr)_auto]"
                >
                  <span className="col-span-2 text-[12px] text-muted-foreground sm:col-span-1 sm:text-[12.5px]">
                    <LocalTime iso={e.at} style="datetime" />
                  </span>
                  <span className="min-w-0 break-words text-[13.5px] leading-[21px] text-foreground">
                    <span className="font-medium">{e.actor.name}</span> ·{' '}
                    {lowerFirst(
                      renamedFrom.has(e.eventId)
                        ? 'Renamed the workspace'
                        : (ledgerWords(e.action, e.payload, e.targetId) ??
                            actionLabel(e.action, e.payload)),
                    )}
                    <Detail
                      item={e}
                      title={e.targetType === 'finding' ? titles.get(e.targetId) : undefined}
                      previousName={renamedFrom.get(e.eventId)}
                    />
                    {(e.action === 'gate1.approve' || e.action === 'gate2.approve') &&
                    e.payload.selfApproved === true ? (
                      <span className="ml-2 inline-flex align-middle">
                        <Chip tone="muted">Self-approved</Chip>
                      </span>
                    ) : null}
                    {target === undefined ? null : (
                      <>
                        {' '}
                        <NavLink
                          href={target.href(e.targetId)}
                          prefetch={false}
                          className="whitespace-nowrap text-[12.5px] font-medium text-gold-ink underline-offset-2 hover:underline"
                        >
                          {target.label}
                        </NavLink>
                      </>
                    )}
                  </span>
                  <span
                    className="text-right font-mono text-[11.5px] leading-[21px] text-muted-foreground"
                    title={e.hash}
                  >
                    #{e.seq} · {e.hash.slice(0, 6)}
                  </span>
                </li>
              );
            })}
          </ol>
          {onlySetup ? (
            <p className="m-0 text-[13px] leading-5 text-muted-foreground">
              Approving a plan, deciding on a request, releasing a finding or stopping an audit each
              adds an entry here.
            </p>
          ) : null}
          {shown.length < items.length ? (
            <p className="m-0 text-[12.5px] text-muted-foreground">
              Showing the newest {shown.length.toLocaleString()} of {chain.count.toLocaleString()}{' '}
              entries.{' '}
              <NavLink
                href="/ledger?all=1"
                prefetch={false}
                className="font-medium text-gold-ink underline-offset-2 hover:underline"
              >
                {items.length < chain.count
                  ? `Show the newest ${items.length.toLocaleString()}`
                  : 'Show all'}
              </NavLink>
            </p>
          ) : items.length < chain.count ? (
            <p className="m-0 text-[12.5px] text-muted-foreground">
              Showing the newest {items.length.toLocaleString()} of {chain.count.toLocaleString()}{' '}
              entries. The check covers all of them.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
