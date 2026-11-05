'use client';

// Targets (experience spec §2, §4, bug 13): the sites in this workspace. "Add target" runs the order's first two
// steps inline; verification shows only for the row where the person picks Verify.
import { useState } from 'react';

import { AskField, findKnown, useNormalized } from './ask-field';
import { dayLabel, isVerified, originOf, refreshSidebar } from './shared';
import { type ProofMethod, VerifyOwnership } from './verify-ownership';
import { ensureTargetAction } from '../../../app/(console)/audits/actions';
import { buttonClass, EmptyState, Icon, InlineMessage, LinkButton } from '../design';
import { PendingButton } from '../design-client';
import { normalizeTarget } from '../../../lib/normalize';

import type { Asset } from '../../../lib/schemas';

function VerifyPanel({ asset, viewerName, onVerified }: { readonly asset: Asset; readonly viewerName: string; readonly onVerified: (a: Asset) => void }) {
  const [method, setMethod] = useState<ProofMethod>('file');
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
    const created = await ensureTargetAction(r.origin, r.host);
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
        showError={showError || /:\/\//.test(text)}
        onBlur={() => {
          setShowError(text.trim() !== '');
        }}
        onEnter={() => {
          document.querySelector<HTMLButtonElement>('[data-add-target] button')?.click();
        }}
        autoFocus
      />
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
        <EmptyState
          icon="host"
          title="No targets yet."
          body="Add the first one, and we'll help you prove it's yours."
          action={
            <button
              type="button"
              onClick={() => {
                setAdding(true);
              }}
              className={buttonClass('primary', 'h-11 rounded-xl')}
            >
              <Icon name="plus" size={16} />
              Add target
            </button>
          }
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
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-[14.5px] font-semibold text-foreground">{a.name}</span>
                    <span className="truncate font-mono text-[12px] text-muted-foreground">{origin}</span>
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
                        {a.ownership.method === 'http_token' ? 'File' : 'Confirmed'}
                        {a.ownership.verifiedBy === null ? '' : ` by ${a.ownership.verifiedBy}`}, {dayLabel(a.ownership.verifiedAt)}
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
