/* eslint-disable @typescript-eslint/no-magic-numbers -- display truncation (hashes) */
// Ledger (experience spec §2, §8): every decision in the workspace, newest first, hash-chained. The API re-verifies
// the whole chain on each load; the pill says what it found.
import Link from 'next/link';

import { Chip, EmptyState, Icon } from '../../../components/console/design';
import { LocalTime } from '../../../components/console/results/local-time';
import { actionLabel, ledgerSchema, type LedgerItem } from '../../../components/console/results/model';
import { callApi } from '../../../lib/api';
import { getViewer } from '../../../lib/auth';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Ledger' };

const TARGET_HREF: Readonly<Record<string, (id: string) => string>> = {
  request: (id) => `/audits/${id}`,
  run: (id) => `/runs/${id}`,
  finding: (id) => `/findings/${id}`,
  gate2: (id) => `/decisions/gate2/${id}`,
};

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** The one line of context an entry carries: the request it allowed, the name it set, the reason given. */
function Detail({ item }: { readonly item: LedgerItem }) {
  const p = item.payload;
  const method = text(p.method);
  const url = text(p.url);
  const name = text(p.name);
  const reason = text(p.reason);
  return (
    <span className="text-muted-foreground">
      {method !== null && url !== null ? (
        <span className="break-all font-mono text-[12px]">
          {' '}
          {method.toUpperCase()} {pathOf(url)}
        </span>
      ) : null}
      {item.action === 'workspace.named' && name !== null ? <> &ldquo;{name}&rdquo;</> : null}
      {reason === null ? null : <> &ldquo;{reason}&rdquo;</>}
    </span>
  );
}

export default async function LedgerPage(): Promise<ReactNode> {
  const session = await getViewer();
  if (session === null) return null;
  const { items, chain } = ledgerSchema.parse(await callApi(session, '/audit'));
  const head = items[0]?.hash ?? null;
  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-[28px] font-semibold leading-9 tracking-[-0.01em] text-foreground">Ledger</h1>
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
          Every decision made in this workspace, newest first. Each entry&rsquo;s fingerprint covers the one before it, so
          changing or removing any entry breaks the chain, and the check below fails.
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
            className={`flex scroll-mt-6 flex-wrap items-start gap-3 rounded-[14px] border px-4 py-3.5 ${chain.verified ? 'border-border bg-card' : 'border-bad bg-bad-soft'}`}
          >
            <span
              className={`flex size-8 shrink-0 items-center justify-center rounded-[10px] ${chain.verified ? 'bg-ok-soft text-ok' : 'bg-card text-bad'}`}
            >
              <Icon name={chain.verified ? 'shield' : 'warn'} size={17} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[13.5px] leading-5">
              <span className="font-semibold text-foreground">
                {chain.verified
                  ? `Chain verified: all ${chain.count.toLocaleString()} ${chain.count === 1 ? 'entry links' : 'entries link'} up.`
                  : `Chain check failed at entry #${chain.brokenAtSeq}. Entries from there on cannot be trusted.`}
              </span>
              <span className="text-muted-foreground">
                Checked when you opened this page.{' '}
                {head === null ? null : (
                  <>
                    Newest fingerprint <span className="break-all font-mono text-[12px] text-foreground">sha256 {head}</span>
                  </>
                )}
              </span>
            </div>
          </section>

          <ol className="m-0 flex list-none flex-col overflow-hidden rounded-[14px] border border-border bg-card p-0">
            {items.map((e) => {
              const href = TARGET_HREF[e.targetType]?.(e.targetId);
              return (
                <li
                  key={e.eventId}
                  className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-b border-border px-4 py-3 last:border-b-0 sm:grid-cols-[132px_minmax(0,1fr)_auto]"
                >
                  <span className="col-span-2 text-[12px] text-muted-foreground sm:col-span-1 sm:text-[12.5px]">
                    <LocalTime iso={e.at} style="datetime" />
                  </span>
                  <span className="min-w-0 break-words text-[13.5px] leading-[21px] text-foreground">
                    <span className="font-medium">{e.actor.name}</span> · {actionLabel(e.action).toLowerCase()}
                    <Detail item={e} />
                    {e.payload.selfApproved === true ? (
                      <span className="ml-2 inline-flex align-middle">
                        <Chip tone="gold">Self-approved</Chip>
                      </span>
                    ) : null}
                    {href === undefined ? null : (
                      <>
                        {' '}
                        <Link href={href} className="whitespace-nowrap text-[12.5px] font-medium text-gold-ink underline-offset-2 hover:underline">
                          Open
                        </Link>
                      </>
                    )}
                  </span>
                  <span className="text-right font-mono text-[11.5px] leading-[21px] text-muted-foreground" title={e.hash}>
                    #{e.seq} · {e.hash.slice(0, 6)}
                  </span>
                </li>
              );
            })}
          </ol>
          {items.length < chain.count ? (
            <p className="m-0 text-[12.5px] text-muted-foreground">
              Showing the newest {items.length.toLocaleString()} of {chain.count.toLocaleString()} entries. The check
              covers all of them.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
