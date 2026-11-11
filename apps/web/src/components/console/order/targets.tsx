'use client';

// Targets (experience spec §2, §4, bug 13): the sites in this workspace. "Add target" runs the order's first two
// steps inline; verification shows only for the row where the person picks Verify.
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { AskField, findKnown, useNormalized } from './ask-field';
import { LocalTime } from './local-time';
import {
  dayLabel,
  FORBIDDEN_MESSAGE,
  isForbiddenHost,
  isVerified,
  originOf,
  refreshSidebar,
} from './shared';
import { VerifyOwnership } from './verify-ownership';
import { ensureTargetAction, removeTargetAction } from '../../../app/(console)/audits/actions';
import { normalizeTarget, type TargetResult } from '../../../lib/normalize';
import { buttonClass, Icon, InlineMessage, LinkButton } from '../design';
import { ChipInput, PendingButton } from '../design-client';

import type { Asset } from '../../../lib/schemas';

function VerifyPanel({
  asset,
  viewerName,
  onVerified,
  onClose,
}: {
  readonly asset: Asset;
  readonly viewerName: string;
  readonly onVerified: (a: Asset) => void;
  readonly onClose: () => void;
}) {
  const [attested, setAttested] = useState(false);
  if (isVerified(asset)) {
    const origin = originOf(asset);
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-dashed border-border-strong bg-ok-soft px-4 py-4 sm:px-5"
      >
        <span className="flex min-w-0 flex-1 basis-[240px] items-start gap-3">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-ok text-white">
            <Icon name="check" size={12} />
          </span>
          <span className="text-[13.5px] leading-5 text-foreground">
            <b className="font-semibold">
              You are authorised to test this site.
            </b>{' '}
            <span className="text-muted-foreground">
              Blackwing may audit it once you approve a plan.
            </span>
          </span>
        </span>
        <LinkButton
          href={`/audits/new?target=${encodeURIComponent(origin)}&step=3`}
          variant="primary"
          className="h-10 w-full sm:w-auto"
        >
          Start an audit of {new URL(origin).host}
          <Icon name="arrow" size={15} />
        </LinkButton>
        <button
          type="button"
          onClick={onClose}
          className={buttonClass('ghost', 'h-10 max-sm:w-full')}
        >
          Close
        </button>
      </div>
    );
  }
  const host = new URL(originOf(asset)).host;
  if (isForbiddenHost(host)) {
    return (
      <div className="flex flex-col gap-3 border-t border-dashed border-border-strong bg-sidebar px-4 py-4 sm:px-5">
        <InlineMessage tone="bad">
          {FORBIDDEN_MESSAGE}
        </InlineMessage>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-t border-dashed border-border-strong bg-sidebar px-4 py-4 sm:px-5">
      <p className="m-0 text-[13.5px] text-muted-foreground">
        Blackwing tests only sites you own or have written permission to test.
      </p>
      <VerifyOwnership
        asset={asset}
        viewerName={viewerName}
        attested={attested}
        onAttested={setAttested}
        onVerified={onVerified}
        confirmButton
      />
    </div>
  );
}

const MAX_ORIGINS = 50;
/** 0.0.0.0 and friends name no machine you could reach. */
const isUnroutableHost = (host: string): boolean => /^(0(\.0){0,3}|\[::\])(:\d+)?$/.test(host);
/** A loopback address on the port this console is served from. */
const isOwnConsole = (host: string, port: string): boolean =>
  port !== '' &&
  /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(host.replace(/:\d+$/, '')) &&
  host.endsWith(`:${port}`);
/** How long typing pauses before the API is asked about the address. */
const ASK_PAUSE_MS = 350;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
/** A client-side refusal of the address itself (not a signed-out session, a busy server or an outage). */
const isRefusal = (status: number): boolean =>
  status >= HTTP_BAD_REQUEST &&
  status < HTTP_SERVER_ERROR &&
  status !== HTTP_UNAUTHORIZED &&
  status !== HTTP_TOO_MANY;

/** Extra origins typed or pasted as a list, through the same forgiving normaliser as the site itself. */
function addOrigins(
  raw: string,
  existing: readonly string[],
): { values: readonly string[]; error: string | null } {
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
  /** `existed`: the address was already a target, so nothing new was added. */
  readonly onAdded: (a: Asset, existed: boolean) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [showError, setShowError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The API refused this exact text: the preview must not claim it was understood. */
  const [refusedFor, setRefusedFor] = useState<{ text: string; message: string } | null>(null);
  const [extra, setExtra] = useState<readonly string[] | null>(null);
  const typed = useNormalized(text);
  const [consoleHost, setConsoleHost] = useState<{ port: string } | null>(null);
  useEffect(() => {
    setConsoleHost({ port: window.location.port });
  }, []);
  // Private and local addresses are refused unless the operator listed them as labs: only the API knows, so the
  // preview asks it (after a short pause in typing) instead of waiting for the Add button.
  const [asked, setAsked] = useState<{ origin: string; message: string | null } | null>(null);
  const askOrigin = typed.ok ? typed.origin : null;
  useEffect(() => {
    if (askOrigin === null) return;
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        const res = await fetch(`/api/target-check?origin=${encodeURIComponent(askOrigin)}`, {
          cache: 'no-store',
          signal: ctrl.signal,
        }).catch(() => null);
        const parsed =
          res?.ok === true
            ? z
                .object({ refusal: z.string().nullable() })
                .safeParse(await res.json().catch(() => null))
            : null;
        if (parsed?.success === true && !ctrl.signal.aborted)
          setAsked({ origin: askOrigin, message: parsed.data.refusal });
      })();
    }, ASK_PAUSE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [askOrigin]);
  const askedRefusal = typed.ok && asked?.origin === typed.origin ? asked.message : null;
  const refusal =
    askedRefusal ??
    (typed.ok && isForbiddenHost(typed.host)
      ? FORBIDDEN_MESSAGE
      : typed.ok && isUnroutableHost(typed.host)
        ? "That is not an address a site can be reached at. Use the site's real address."
        : typed.ok && consoleHost !== null && isOwnConsole(typed.host, consoleHost.port)
          ? 'Blackwing cannot test its own console or API.'
          : refusedFor?.text === text
            ? refusedFor.message
            : null);
  const result: TargetResult = refusal === null ? typed : { ok: false, message: refusal };
  const add = async (): Promise<boolean> => {
    setError(null);
    const r = normalizeTarget(text);
    if (!r.ok) {
      setShowError(true);
      return false;
    }
    const existing = findKnown(assets, r.origin);
    if (existing !== undefined) {
      onAdded(existing, true);
      return true;
    }
    const created = await ensureTargetAction(
      r.origin,
      r.host,
      (extra ?? []).filter((o) => o !== r.origin),
    );
    if (!created.ok) {
      if (isRefusal(created.status)) setRefusedFor({ text, message: created.message });
      else setError(created.message);
      return false;
    }
    refreshSidebar();
    onAdded(created.data, false);
    return true;
  };
  return (
    <section
      aria-labelledby="add-target-h"
      className="flex flex-col gap-3 rounded-[16px] border border-gold-line bg-card p-4 sm:p-5"
    >
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
        showError={showError || refusal !== null || text.includes('://')}
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
            Blackwing may send requests to these too, for example the app&apos;s API on its own
            address. Only add addresses you are authorised to test.
          </p>
        </div>
      )}
      {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
      <div className="flex flex-wrap items-center gap-2.5">
        <span data-add-target className="contents">
          <PendingButton
            onAction={add}
            disabled={text.trim() === '' || refusal !== null}
            pendingLabel="Adding…"
          >
            Add target
          </PendingButton>
        </span>
        <button type="button" onClick={onCancel} className={buttonClass('ghost')}>
          Cancel
        </button>
        <span className="text-[12px] text-muted-foreground">
          Nothing is sent to the site until you choose how to verify it.
        </span>
      </div>
    </section>
  );
}

const FIRST_STEPS = [
  { title: 'Add the address', body: 'The web app you want audited.' },
  {
    title: "Prove it's yours",
    body: 'A small file on the site, or your word for an internal system.',
  },
  { title: 'Start an audit', body: 'Blackwing plans it; nothing runs until you approve.' },
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
          A target is a web app Blackwing may audit. Add its address, then show it&apos;s yours.
          Nothing is sent to the site until you choose how.
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
      <button
        type="button"
        onClick={onAdd}
        className={buttonClass('primary', 'h-11 rounded-xl px-5')}
      >
        <Icon name="plus" size={16} />
        Add target
      </button>
    </section>
  );
}

/** Verified first (ready for an audit), then the rest; by name within each. Kept in place while the page is open. */
const byReadiness = (a: Asset, b: Asset): number =>
  Number(isVerified(b)) - Number(isVerified(a)) || a.name.localeCompare(b.name);

/** One width for every row's action (Verify, Close, New audit), so the status column lines up. */
const ACTION_WIDTH = 'sm:w-[112px]';

export function Targets({
  initial,
  viewerName,
}: {
  readonly initial: readonly Asset[];
  readonly viewerName: string;
}) {
  const [assets, setAssets] = useState<readonly Asset[]>(() => [...initial].sort(byReadiness));
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  /** A site added again: its row is scrolled to and marked, so the click is never lost. */
  const [again, setAgain] = useState<string | null>(null);
  /** The row whose removal is being confirmed, and any refusal from the API. */
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const remove = async (id: string): Promise<boolean> => {
    const r = await removeTargetAction(id);
    if (!r.ok) {
      setRemoveError(r.message);
      return false;
    }
    setAssets((list) => list.filter((x) => x.id !== id));
    setRemoving(null);
    setRemoveError(null);
    setOpen((o) => (o === id ? null : o));
    refreshSidebar();
    return true;
  };
  const justVerified = open !== null && assets.some((a) => a.id === open && isVerified(a));
  useEffect(() => {
    if (again === null) return;
    document
      .getElementById(`target-${again}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [again]);
  // An opened Verify panel comes fully into view (a row low on the page would open below the fold).
  useEffect(() => {
    if (open === null) return;
    document
      .getElementById(`target-${open}`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open]);

  const upsert = (a: Asset): void => {
    setAssets((list) =>
      list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [a, ...list],
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-[780px] flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[28px] font-semibold leading-[36px] tracking-[-0.01em] text-foreground">
            Targets
          </h1>
          <p className="m-0 text-[14.5px] text-muted-foreground">
            The sites in this workspace. Blackwing audits only the ones you&apos;ve proven are
            yours.
          </p>
        </div>
        {adding || assets.length === 0 ? null : (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setOpen(null);
              setAgain(null);
            }}
            className={buttonClass(justVerified ? 'secondary' : 'primary', 'h-11 rounded-xl')}
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
          onAdded={(a, existed) => {
            upsert(a);
            setAdding(false);
            setAgain(existed ? a.id : null);
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
            const blocked = isForbiddenHost(new URL(origin).host);
            return (
              <li
                key={a.id}
                id={`target-${a.id}`}
                className={`overflow-hidden rounded-[14px] border bg-card transition-shadow ${again === a.id ? 'border-gold-ink shadow-[0_0_0_3px_var(--gold-line)]' : 'border-border'}`}
              >
                {again === a.id ? (
                  <p
                    role="status"
                    className="m-0 flex items-center gap-2 border-b border-gold-line bg-gold-soft px-4 py-2 text-[12.5px] text-gold-ink sm:px-5"
                  >
                    <Icon name="info" size={13} />
                    You already added this site{isVerified(a) ? ', and it is verified' : ''}.
                  </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 sm:px-5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-muted-foreground">
                    <Icon name="web" size={18} />
                  </span>
                  <span className="flex min-w-0 flex-1 basis-[220px] flex-col gap-0.5">
                    <span className="truncate text-[14.5px] font-semibold text-foreground">
                      {a.name}
                    </span>
                    <span className="truncate font-mono text-[12px] text-muted-foreground">
                      {origin}
                    </span>
                    {a.allowedOrigins.some((o) => o !== origin) ? (
                      <span className="truncate text-[12px] text-muted-foreground">
                        Also calls:{' '}
                        <span className="font-mono">
                          {a.allowedOrigins.filter((o) => o !== origin).join(', ')}
                        </span>
                      </span>
                    ) : null}
                    {a.excludedPaths.length === 0 ? null : (
                      <span className="truncate text-[12px] text-muted-foreground">
                        Always avoided:{' '}
                        <span className="font-mono">{a.excludedPaths.join(', ')}</span>
                      </span>
                    )}
                  </span>
                  <span className="flex flex-col items-start gap-0.5 sm:w-[200px] sm:items-end sm:text-right">
                    {verified ? (
                      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-ok-soft px-2.5 text-[12px] font-medium text-ok">
                        <Icon name="check" size={12} />
                        Verified
                      </span>
                    ) : blocked ? (
                      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-bad-soft px-2.5 text-[12px] font-medium text-bad">
                        Blocked: can never be tested
                      </span>
                    ) : (
                      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 text-[12px] font-medium text-muted-foreground">
                        Not verified yet
                      </span>
                    )}
                    {verified && a.ownership.verifiedAt !== null ? (
                      // Who on one line, the day on its own: a date never breaks across lines.
                      <span className="flex flex-col text-[11.5px] text-muted-foreground sm:items-end">
                        <span>
                          Confirmed
                          {a.ownership.verifiedBy === null ? '' : ` by ${a.ownership.verifiedBy}`}
                        </span>
                        <span className="whitespace-nowrap">
                          <LocalTime iso={a.ownership.verifiedAt} format={dayLabel} />
                        </span>
                      </span>
                    ) : null}
                  </span>
                  {verified && expanded ? null : verified ? (
                    <LinkButton
                      href={`/audits/new?target=${encodeURIComponent(origin)}&step=3`}
                      variant="secondary"
                      className={`h-10 w-full ${ACTION_WIDTH}`}
                    >
                      New audit
                    </LinkButton>
                  ) : blocked ? (
                    <span className={`hidden ${ACTION_WIDTH}`} aria-hidden="true" />
                  ) : (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => {
                        setOpen(expanded ? null : a.id);
                        setAdding(false);
                      }}
                      className={buttonClass('secondary', `h-10 w-full ${ACTION_WIDTH}`)}
                    >
                      {expanded ? 'Close' : 'Verify'}
                    </button>
                  )}
                </div>
                {removing === a.id ? (
                  <div
                    role="alertdialog"
                    aria-label={`Remove ${a.name}`}
                    className="flex flex-col gap-3 border-t border-dashed border-border-strong bg-sidebar px-4 py-4 sm:px-5"
                  >
                    <p className="m-0 text-[13.5px] text-foreground">
                      Remove <b className="font-semibold">{a.name}</b> from this workspace? Past
                      audits and the ledger keep their record of it. You can add it again later.
                    </p>
                    {removeError === null ? null : (
                      <InlineMessage tone="bad">{removeError}</InlineMessage>
                    )}
                    <div className="flex flex-wrap gap-2.5">
                      <PendingButton onAction={() => remove(a.id)} pendingLabel="Removing…">
                        Remove target
                      </PendingButton>
                      <button
                        type="button"
                        onClick={() => {
                          setRemoving(null);
                          setRemoveError(null);
                        }}
                        className={buttonClass('ghost')}
                      >
                        Keep it
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex justify-end border-t border-border px-4 py-1.5 sm:px-5">
                    <button
                      type="button"
                      onClick={() => {
                        setRemoving(a.id);
                        setRemoveError(null);
                      }}
                      aria-label={`Remove ${a.name}`}
                      className="inline-flex h-8 items-center rounded-lg px-2 text-[12.5px] font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
                    >
                      Remove
                    </button>
                  </div>
                )}
                {expanded ? (
                  <VerifyPanel
                    asset={a}
                    viewerName={viewerName}
                    onVerified={(v) => {
                      upsert(v);
                      refreshSidebar();
                    }}
                    onClose={() => {
                      setOpen(null);
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
