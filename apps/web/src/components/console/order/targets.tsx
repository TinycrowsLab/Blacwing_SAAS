'use client';

// Targets (experience spec §2, §4, bug 13): the sites in this workspace. "Add target" runs the order's first two
// steps inline; verification shows only for the row where the person picks Verify.
import { useState } from 'react';

import { AskField, findKnown, useNormalized } from './ask-field';
import { LocalTime } from './local-time';
import { dayLabel, isVerified, originOf, recommendedProof, refreshSidebar } from './shared';
import { type ProofMethod, VerifyOwnership } from './verify-ownership';
import { ensureTargetAction } from '../../../app/(console)/audits/actions';
import { normalizeTarget } from '../../../lib/normalize';
import { buttonClass, Icon, InlineMessage, LinkButton } from '../design';
import { ChipInput, PendingButton } from '../design-client';

import type { Asset } from '../../../lib/schemas';

function VerifyPanel({ asset, viewerName, onVerified }: { readonly asset: Asset; readonly viewerName: string; readonly onVerified: (a: Asset) => void }) {
  const [method, setMethod] = useState<ProofMethod>(() => recommendedProof(new URL(originOf(asset)).host));
  const [attested, setAttested] = useState(false);
  return (
    <div className="flex flex-col gap-3 border-t border-dashed border-border-strong bg-sidebar px-4 py-4 sm:px-5">
      <p className="m-0 text-[13.5px] text-muted-foreground">
        We only test sites you can show you control. Pick the way that suits you.
      </p>
      <VerifyOwnership
        asset={asset}
        viewerName={viewerName}
        method={method}
        onMethod={setMethod}
        attested={attested}
        onAttested={setAttested}
        onVerified={onVerified}
        confirmButton
      />
    </div>
  );
}

const MAX_ORIGINS = 50;

/** Extra origins typed or pasted as a list, through the same forgiving normaliser as the site itself. */
function addOrigins(raw: string, existing: readonly string[]): { values: readonly string[]; error: string | null } {
  const values = [...existing];
  let error: string | null = null;
  for (const token of raw.split(/[\s,]+/).filter(Boolean)) {
    const r = normalizeTarget(token);
    if (!r.ok) error = r.message;
    else if (!values.includes(r.origin)) values.push(r.origin);
  }
  if (values.length > MAX_ORIGINS) error = `Up to ${MAX_ORIGINS} addresses.`;
  return { values: values.slice(0, MAX_ORIGINS), error };
}

function AddTarget({
  assets,
  onAdded,
  onCancel,
}: {
  readonly assets: readonly Asset[];
  readonly onAdded: (a: Asset) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [showError, setShowError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState<readonly string[] | null>(null);
  const result = useNormalized(text);
  const add = async (): Promise<boolean> => {
    setError(null);
    const r = normalizeTarget(text);
    if (!r.ok) {
      setShowError(true);
      return false;
    }
    const existing = findKnown(assets, r.origin);
    if (existing !== undefined) {
      onAdded(existing);
      return true;
    }
    const created = await ensureTargetAction(
      r.origin,
      r.host,
      (extra ?? []).filter((o) => o !== r.origin),
    );
    if (!created.ok) {
      setError(created.message);
      return false;
    }
    refreshSidebar();
    onAdded(created.data);
    return true;
  };
  return (
    <section aria-labelledby="add-target-h" className="flex flex-col gap-3 rounded-[16px] border border-gold-line bg-card p-4 sm:p-5">
      <h2 id="add-target-h" className="m-0 text-[15px] font-semibold text-foreground">
        Add a target
      </h2>
      <AskField
        id="targets-add"
        label="Web address"
        text={text}
        onText={(t) => {
          setText(t);
          setShowError(false);
        }}
        result={result}
        known={assets}
        showError={showError || text.includes('://')}
        onBlur={() => {
          setShowError(text.trim() !== '');
        }}
        onEnter={() => {
          document.querySelector<HTMLButtonElement>('[data-add-target] button')?.click();
        }}
        autoFocus
      />
      {extra === null ? (
        <button
          type="button"
          onClick={() => {
            setExtra([]);
          }}
          className="inline-flex h-9 items-center gap-1.5 self-start rounded-lg px-2 text-[13px] font-medium text-gold-ink hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          <Icon name="plus" size={14} />
          This app also calls another address
        </button>
      ) : (
        <div className="flex flex-col gap-1.5">
          <ChipInput
            label="Other addresses it calls"
            values={extra}
            onChange={setExtra}
            parse={(raw, existing) => addOrigins(raw, existing)}
            placeholder="api.example.com, cdn.example.com"
          />
          <p className="m-0 text-[12.5px] text-muted-foreground">
            Claude may send requests to these too, for example the app&apos;s API on its own address.
          </p>
        </div>
      )}
      {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
      <div className="flex flex-wrap items-center gap-2.5">
        <span data-add-target className="contents">
          <PendingButton onAction={add} disabled={text.trim() === ''} pendingLabel="Adding…">
            Add target
          </PendingButton>
        </span>
        <button type="button" onClick={onCancel} className={buttonClass('ghost')}>
          Cancel
        </button>
        <span className="text-[12px] text-muted-foreground">Nothing is sent to the site until you choose how to verify it.</span>
      </div>
    </section>
  );
}

const FIRST_STEPS = [
  { title: 'Add the address', body: 'The web app you want audited.' },
  { title: "Prove it's yours", body: "A small file on the site, or your word for an internal system." },
  { title: 'Start an audit', body: 'Claude plans it; nothing runs until you approve.' },
] as const;

/** No targets yet: what a target is, how proving it works, and the one way forward. */
function FirstTarget({ onAdd }: { readonly onAdd: () => void }) {
  return (
    <section
      aria-labelledby="targets-empty-h"
      className="flex flex-col items-center gap-5 rounded-[18px] border border-dashed border-border-strong bg-card px-5 py-10 text-center sm:px-10"
    >
      <span className="flex size-11 items-center justify-center rounded-[12px] bg-gold-soft text-gold-ink shadow-[inset_0_0_0_1px_var(--gold-line)]">
        <Icon name="host" size={20} />
      </span>
      <div className="flex max-w-[460px] flex-col gap-1.5">
        <h2 id="targets-empty-h" className="m-0 text-[17px] font-semibold text-foreground">
          No targets yet.
        </h2>
        <p className="m-0 text-[13.5px] leading-[21px] text-muted-foreground">
          A target is a web app Claude may audit. Add its address, then show it&apos;s yours. Nothing is sent to the site
          until you choose how.
        </p>
      </div>
      <ol className="m-0 grid w-full max-w-[640px] list-none gap-2.5 p-0 text-left sm:grid-cols-3">
        {FIRST_STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-2.5 rounded-[12px] bg-surface-2 px-3.5 py-3">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-card text-[11.5px] font-semibold tabular-nums text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
              {i + 1}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-foreground">{s.title}</span>
              <span className="text-[12px] leading-[17px] text-muted-foreground">{s.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <button type="button" onClick={onAdd} className={buttonClass('primary', 'h-11 rounded-xl px-5')}>
        <Icon name="plus" size={16} />
        Add target
      </button>
    </section>
  );
}

export function Targets({ initial, viewerName }: { readonly initial: readonly Asset[]; readonly viewerName: string }) {
  const [assets, setAssets] = useState<readonly Asset[]>(initial);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const upsert = (a: Asset): void => {
    setAssets((list) => (list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [a, ...list]));
  };

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[28px] font-semibold leading-[36px] tracking-[-0.01em] text-foreground">Targets</h1>
          <p className="m-0 text-[14.5px] text-muted-foreground">
            The sites in this workspace. Claude audits only the ones you&apos;ve proven are yours.
          </p>
        </div>
        {adding || assets.length === 0 ? null : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setOpen(null);
            }}
            className={buttonClass('primary', 'h-11 rounded-xl')}
          >
            <Icon name="plus" size={16} />
            Add target
          </button>
        )}
      </div>

      {adding ? (
        <AddTarget
          assets={assets}
          onCancel={() => {
            setAdding(false);
          }}
          onAdded={(a) => {
            upsert(a);
            setAdding(false);
            if (!isVerified(a)) setOpen(a.id);
          }}
        />
      ) : null}

      {assets.length === 0 && !adding ? (
        <FirstTarget
          onAdd={() => {
            setAdding(true);
          }}
        />
      ) : null}

      {assets.length === 0 ? null : (
        <ul aria-label="Targets" className="m-0 flex list-none flex-col gap-2.5 p-0">
          {assets.map((a) => {
            const verified = isVerified(a);
            const origin = originOf(a);
            const expanded = open === a.id;
            return (
              <li key={a.id} className="overflow-hidden rounded-[14px] border border-border bg-card">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 sm:px-5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-muted-foreground">
                    <Icon name="web" size={18} />
                  </span>
                  <span className="flex min-w-0 flex-1 basis-[220px] flex-col gap-0.5">
                    <span className="truncate text-[14.5px] font-semibold text-foreground">{a.name}</span>
                    <span className="truncate font-mono text-[12px] text-muted-foreground">{origin}</span>
                    {a.allowedOrigins.some((o) => o !== origin) ? (
                      <span className="truncate text-[12px] text-muted-foreground">
                        Also calls:{' '}
                        <span className="font-mono">{a.allowedOrigins.filter((o) => o !== origin).join(', ')}</span>
                      </span>
                    ) : null}
                    {a.excludedPaths.length === 0 ? null : (
                      <span className="truncate text-[12px] text-muted-foreground">
                        Always avoided: <span className="font-mono">{a.excludedPaths.join(', ')}</span>
                      </span>
                    )}
                  </span>
                  <span className="flex flex-col items-start gap-0.5 sm:items-end">
                    {verified ? (
                      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-ok-soft px-2.5 text-[12px] font-medium text-ok">
                        <Icon name="check" size={12} />
                        Verified
                      </span>
                    ) : (
                      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-[12px] font-medium text-muted-foreground">
                        Not verified yet
                      </span>
                    )}
                    {verified && a.ownership.verifiedAt !== null ? (
                      <span className="text-[11.5px] text-muted-foreground">
                        {a.ownership.method === 'http_token' ? 'Verified with a file' : 'Confirmed'}
                        {a.ownership.verifiedBy === null ? '' : ` by ${a.ownership.verifiedBy}`},{' '}
                        <LocalTime iso={a.ownership.verifiedAt} format={dayLabel} />
                      </span>
                    ) : null}
                  </span>
                  {verified ? (
                    <LinkButton
                      href={`/audits/new?target=${encodeURIComponent(origin)}&step=3`}
                      variant="secondary"
                      className="h-10 w-full sm:w-auto"
                    >
                      New audit
                    </LinkButton>
                  ) : (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => {
                        setOpen(expanded ? null : a.id);
                        setAdding(false);
                      }}
                      className={buttonClass('secondary', 'h-10 w-full sm:w-auto')}
                    >
                      {expanded ? 'Close' : 'Verify'}
                    </button>
                  )}
                </div>
                {expanded ? (
                  <VerifyPanel
                    asset={a}
                    viewerName={viewerName}
                    onVerified={(v) => {
                      upsert(v);
                      refreshSidebar();
                    }}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
