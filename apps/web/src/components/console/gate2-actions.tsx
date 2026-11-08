/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Gate 2 actions (experience spec §6.2): Deny is ink, has the D key (and the default focus on the full page); "Allow
// for this run…" (A) reveals the reason field, and Allow enables at 8 non-space characters (Ctrl/Cmd+Enter submits).
// Decisions wait for the server, because they must be true. A 409 from another tab or person comes back as the decided
// request, so the card shows the receipt instead of an error.
import { type RefObject, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { buttonClass, Icon, InlineMessage, Kbd } from './design';
import { clockLabel, PendingButton, ReasonField, useCountdown } from './design-client';
import { reasonEnough } from '../../lib/normalize';
import { gate2DetailSchema } from '../../lib/schemas';

export type Gate2Detail = z.infer<typeof gate2DetailSchema>;

export const FOOTNOTE =
  'While this waits, Claude carries on with other test cases where it can. Allowing lets this method, path and role through until the audit ends. No answer means denied.';

/** Fired with the decided request, so every card for it in this tab (and a "Deny all") shows the same receipt. */
export const DECIDED_EVENT = 'bw:gate2-decided';

// Decided in this tab. A card rendered again from the router cache (Back, or the sidebar link within its 30 s
// staleTime) shows the receipt at once instead of the old question, so a fast D never meets a 409.
const decidedInTab = new Map<string, Gate2Detail>();
export const decidedHere = (id: string): Gate2Detail | null => decidedInTab.get(id) ?? null;
export function announceDecided(gate2: Gate2Detail): void {
  decidedInTab.set(gate2.id, gate2);
  window.dispatchEvent(new CustomEvent(DECIDED_EVENT, { detail: gate2 }));
}

/** The route and the API cap a reason at this length; the field stops there too. */
const MAX_REASON = 500;
const NEAR_LIMIT = 400;
// One tap, like Gate 1's reasons: each says why changing data here is safe.
const REASONS = ['Our own test lab', 'Test account we own', 'Needed to prove the finding'] as const;

const answerSchema = gate2DetailSchema.extend({ alreadyDecided: z.boolean().optional() });
/** A decision that has no answer by then is checked against the server instead of waiting on forever. */
const DECISION_TIMEOUT_MS = 15_000;
const problemSchema = z.object({ message: z.string().optional() }).loose();

type Decision =
  { ok: true; gate2: Gate2Detail; alreadyDecided: boolean } | { ok: false; message: string | null };

export async function postDecision(
  id: string,
  decision: 'approve' | 'deny',
  reason: string,
): Promise<Decision> {
  try {
    const res = await fetch(`/api/gate2/${encodeURIComponent(id)}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      body: JSON.stringify({
        decision,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const parsed = answerSchema.safeParse(json);
      if (parsed.success) {
        const { alreadyDecided = false, ...gate2 } = parsed.data;
        return { ok: true, gate2, alreadyDecided };
      }
    }
    const problem = problemSchema.safeParse(json);
    return {
      ok: false,
      message: res.status >= 500 || !problem.success ? null : (problem.data.message ?? null),
    };
  } catch {
    return { ok: false, message: null };
  }
}

/** The request as the server has it now (another tab, a teammate or the deadline may have closed it). */
export async function fetchGate2(id: string): Promise<Gate2Detail | null> {
  try {
    const res = await fetch(`/api/gate2/${encodeURIComponent(id)}/decision`, { cache: 'no-store' });
    if (!res.ok) return null;
    const parsed = gate2DetailSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const SCOPE = '[data-gate2-scope]';
const OPEN = '[data-gate2-open]';
const visible = (el: Element): boolean => el.getClientRects().length > 0;

/** How many pixels of `el` the person can see: clipped by the window and by every scrolling ancestor. */
function shownPx(el: Element): number {
  const r = el.getBoundingClientRect();
  let top = Math.max(r.top, 0);
  let bottom = Math.min(r.bottom, window.innerHeight);
  for (let p = el.parentElement; p !== null && bottom > top; p = p.parentElement) {
    if (getComputedStyle(p).overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    top = Math.max(top, pr.top);
    bottom = Math.min(bottom, pr.bottom);
  }
  return Math.max(0, bottom - top);
}

/**
 * The open decision that answers D and A: the one holding the keyboard focus while its buttons are on screen, else
 * the one whose buttons show the most on screen. A card scrolled out of view never answers a key, so a key always acts
 * on the request the person is looking at. One rule for the inbox, the live conversation and the full page, so the
 * ring and the key hints never lie.
 */
function keyOwner(): HTMLElement | null {
  const active = document.activeElement;
  const scope = active instanceof HTMLElement ? active.closest<HTMLElement>(SCOPE) : null;
  const focused = scope?.querySelector<HTMLElement>(OPEN) ?? null;
  if (focused !== null && shownPx(focused) > 0) return focused;
  let best: HTMLElement | null = null;
  let most = 0;
  for (const el of document.querySelectorAll<HTMLElement>(OPEN)) {
    const px = shownPx(el);
    if (px > most) {
      best = el;
      most = px;
    }
  }
  return best;
}

const OWNER_CHANGED = 'bw:gate2-keys';
// After a decision the next card becomes the owner: a second key press this soon was meant for the first one.
const QUIET_MS = 600;
let quietUntil = 0;

const button = (wrap: RefObject<HTMLDivElement | null>): HTMLButtonElement | null =>
  wrap.current?.querySelector('button') ?? null;

const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/** Whether this card's actions answer D and A right now (for the ring and the key hints). */
function useOwnsKeys(root: RefObject<HTMLDivElement | null>): boolean {
  const [owns, setOwns] = useState(false);
  useEffect(() => {
    let frame = 0;
    const update = (): void => {
      setOwns(root.current !== null && keyOwner() === root.current);
    };
    // Scrolling (the page or the conversation) moves the ring to the card in view; once per frame is enough.
    const onScroll = (): void => {
      if (frame === 0)
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          update();
        });
    };
    update();
    window.dispatchEvent(new Event(OWNER_CHANGED));
    const events = ['focusin', 'focusout', 'resize', OWNER_CHANGED] as const;
    for (const e of events) window.addEventListener(e, update);
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      for (const e of events) window.removeEventListener(e, update);
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.cancelAnimationFrame(frame);
      // Let the next card take the ring once this one turns into its receipt.
      window.setTimeout(() => window.dispatchEvent(new Event(OWNER_CHANGED)), 0);
    };
  }, [root]);
  return owns;
}

// A reason survives a reload (spec §10: drafts are safe state). Per tab, per request; storage may be unavailable.
const draftKey = (id: string): string => `bw:gate2-reason:${id}`;
export function readDraft(id: string): string {
  try {
    return window.sessionStorage.getItem(draftKey(id)) ?? '';
  } catch {
    return '';
  }
}
function writeDraft(id: string, text: string): void {
  try {
    if (text.trim() === '') window.sessionStorage.removeItem(draftKey(id));
    else window.sessionStorage.setItem(draftKey(id), text);
  } catch {
    // Private mode or blocked storage: the draft lives only as long as the page.
  }
}

/**
 * The decision buttons. `layout="column"` is the card's right column (it keeps its width while allowing);
 * `"sheet"` is the phone's sticky footer (56 px Deny). `onDecided` gets the decided request, from this tab or from
 * whoever decided first (`alreadyDecided`). `footnote={false}` when the list shows the footnote once for all cards.
 */
export function Gate2Actions({
  gate2Id,
  deadlineAt,
  createdAt,
  layout,
  autoFocus,
  footnote = true,
  scope,
  onDecided,
}: {
  readonly gate2Id: string;
  readonly deadlineAt: string;
  readonly createdAt?: string | undefined;
  readonly layout: 'column' | 'sheet';
  /**
   * Focus Deny once, on mount (the full page, and the inbox's first card), so Enter or D denies. shortcut: skipped on
   * a coarse pointer (touch), where a focus ring with no keyboard only confuses; revisit if phones with keyboards matter.
   */
  readonly autoFocus: boolean;
  readonly footnote?: boolean;
  /** What an allow covers (method, path, role, every agent, any body), shown before the reason is asked for. */
  readonly scope?: string;
  readonly onDecided: (gate2: Gate2Detail, alreadyDecided: boolean) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const denyWrap = useRef<HTMLDivElement>(null);
  const allowWrap = useRef<HTMLDivElement>(null);
  const [allowing, setAllowing] = useState(false);
  const [reason, setReason] = useState('');
  const [failed, setFailed] = useState<{
    decision: 'approve' | 'deny';
    message: string | null;
  } | null>(null);
  const clock = useCountdown(deadlineAt, createdAt);
  const enough = reasonEnough(reason);
  const owns = useOwnsKeys(root);
  const sheet = layout === 'sheet';

  // A reason typed before a reload comes back, with the field open (after mount: storage is the browser's).
  useEffect(() => {
    const draft = readDraft(gate2Id);
    if (draft === '') return;
    setReason(draft);
    setAllowing(true);
  }, [gate2Id]);
  const close = (): void => {
    setAllowing(false);
    writeDraft(gate2Id, '');
  };

  // Returns false on failure so the PendingButton (stayPending) re-arms; on success the card swaps to its receipt.
  const decide = async (decision: 'approve' | 'deny'): Promise<boolean> => {
    setFailed(null);
    const result = await postDecision(gate2Id, decision, decision === 'approve' ? reason : '');
    // No answer (or a failed one) is not a "no": the server says whether a decision was recorded. Still open, the
    // card says so and keeps the reason for Try again; closed, it shows the server's receipt.
    const closed = result.ok ? null : await fetchGate2(gate2Id);
    const receipt = result.ok
      ? result
      : closed !== null && closed.status !== 'pending'
        ? { gate2: closed, alreadyDecided: true }
        : null;
    if (receipt === null) {
      setFailed({ decision, message: result.ok ? null : result.message });
      return false;
    }
    quietUntil = Date.now() + QUIET_MS;
    writeDraft(gate2Id, '');
    onDecided(receipt.gate2, receipt.alreadyDecided);
    announceDecided(receipt.gate2);
    // The sidebar, the inbox and the live run each refresh on this event; the card itself already shows the receipt.
    window.dispatchEvent(new Event('bw:refresh'));
    return true;
  };

  // The confirm button (and a failure under it) is always on screen, even when the card sits low on the page.
  useEffect(() => {
    if (sheet || (!allowing && failed === null)) return;
    const frame = window.requestAnimationFrame(() => {
      (failed === null ? button(allowWrap) : root.current)?.scrollIntoView({ block: 'nearest' });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [allowing, failed, sheet]);

  // Read once: a prop change (a list refresh) must never move the focus onto another request's Deny.
  const focusOnMount = useRef(autoFocus);
  useEffect(() => {
    if (!focusOnMount.current || !window.matchMedia('(pointer: fine)').matches) return;
    const deny = button(denyWrap);
    if (deny === null || !visible(deny) || typing(document.activeElement)) return;
    deny.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const key = e.key.toLowerCase();
      if ((key !== 'd' && key !== 'a') || keyOwner() !== root.current) return;
      e.preventDefault();
      if (Date.now() < quietUntil) return;
      if (key === 'd') button(denyWrap)?.click();
      else setAllowing(true);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const left = clock === null ? null : clockLabel(clock.secondsLeft);
  const error = (decision: 'approve' | 'deny') =>
    failed?.decision !== decision ? null : (
      <InlineMessage tone="bad">
        {failed.message === null
          ? "Couldn't record your decision."
          : `Couldn't record your decision: ${failed.message}`}{' '}
        It&apos;s still open{left === null ? '' : `, with ${left} left`}.{' '}
        <button
          type="button"
          onClick={() => button(decision === 'deny' ? denyWrap : allowWrap)?.click()}
          className="font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        >
          Try again
        </button>
      </InlineMessage>
    );
  // Key hints only where keys exist (md and up, a fine pointer) and only on the card that owns the keys. max-md:hidden,
  // not hidden + md:inline-flex: the Kbd's own inline-flex comes later in the built CSS and would win on phones.
  const kbd = (k: string) =>
    owns && !sheet ? <Kbd className="max-md:hidden pointer-coarse:hidden">{k}</Kbd> : null;

  // Deny never moves or changes weight: ink with the ring at the top of the column, whether or not Allow is open.
  // The column's Deny follows prototype 04: × at the left, the label centred, the key at the right.
  const deny = (
    <div ref={denyWrap} className="contents">
      <PendingButton
        variant="deny"
        pendingLabel="Denying…"
        stayPending
        onAction={() => decide('deny')}
        className={
          sheet
            ? allowing
              ? 'h-11 w-full rounded-[14px]'
              : 'h-14 w-full rounded-[14px] text-base'
            : `h-11 w-full px-3.5 focus-visible:ring-0 ${owns ? 'md:shadow-[0_0_0_2px_var(--card),0_0_0_4px_var(--gold-ink)]' : ''}`
        }
      >
        {sheet ? (
          <span className="inline-flex items-center gap-2">
            <Icon name="x" size={allowing ? 15 : 18} />
            Deny
          </span>
        ) : (
          <span className="grid w-full grid-cols-[1fr_auto_1fr] items-center">
            <Icon name="x" size={15} className="justify-self-start" />
            Deny
            <span className="flex justify-self-end">{kbd('D')}</span>
          </span>
        )}
      </PendingButton>
    </div>
  );

  return (
    <div
      ref={root}
      data-gate2-open=""
      className={`flex flex-col ${sheet ? 'gap-2.5' : 'gap-2'}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && allowing) {
          e.stopPropagation();
          close();
          window.setTimeout(() => button(denyWrap)?.focus(), 0);
        }
      }}
    >
      {sheet ? null : (
        <>
          {deny}
          {error('deny')}
        </>
      )}
      {allowing ? (
        <>
          {scope === undefined ? null : (
            <p className="m-0 flex items-start gap-1.5 rounded-[10px] border border-gold-line bg-gold-soft px-2.5 py-2 text-[12px] leading-[17px] text-foreground">
              <Icon name="info" size={13} className="mt-0.5 shrink-0 text-gold-ink" />
              <span>{scope}</span>
            </p>
          )}
          <ReasonField
            label="Reason (needed to allow)"
            value={reason}
            onChange={(text) => {
              // A paste longer than the cap is cut here, and the count says so, instead of failing at the server.
              const kept = text.slice(0, MAX_REASON);
              setReason(kept);
              writeDraft(gate2Id, kept);
            }}
            onSubmit={() => {
              if (enough) button(allowWrap)?.click();
            }}
            placeholder="Why is it safe to allow this for the rest of the run?"
            suggestions={REASONS}
            footnote={
              reason.length < NEAR_LIMIT
                ? 'Kept on the ledger with your name'
                : `${reason.length} of ${MAX_REASON} characters, the most a reason can hold`
            }
            autoFocus
            rows={sheet ? 2 : 3}
          />
          <div ref={allowWrap} className="contents">
            <PendingButton
              variant="primary"
              pendingLabel="Allowing…"
              disabled={!enough}
              title={enough ? undefined : 'Write a reason of at least 8 characters first'}
              stayPending
              onAction={() => decide('approve')}
              className={sheet ? 'h-12 w-full rounded-[14px] text-[14px]' : 'h-10 w-full'}
            >
              Allow for this run
            </PendingButton>
          </div>
          {sheet ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={close}
                className={buttonClass('ghost', 'h-11 w-full rounded-[14px]')}
              >
                Cancel
              </button>
              {deny}
            </div>
          ) : (
            <button type="button" onClick={close} className={buttonClass('ghost', 'h-10 w-full')}>
              Cancel
            </button>
          )}
          {error('approve')}
          {sheet ? error('deny') : null}
        </>
      ) : (
        <>
          {sheet ? deny : null}
          {sheet ? error('deny') : null}
          <button
            type="button"
            onClick={() => {
              setAllowing(true);
            }}
            className={buttonClass(
              'secondary',
              // border-input-strong!: the base's border-transparent comes later in the built CSS and would win.
              `border-input-strong! ${sheet ? 'h-12 w-full rounded-[14px] text-[14px]' : 'h-11 w-full justify-between! px-3.5'}`,
            )}
          >
            {sheet ? 'Allow for this run, with a reason' : 'Allow for this run…'}
            {kbd('A')}
          </button>
          {error('approve')}
        </>
      )}
      {footnote ? (
        <p
          className={`m-0 text-[11px] leading-4 text-muted-foreground ${sheet ? 'text-center text-[11.5px]' : ''}`}
        >
          {FOOTNOTE}
        </p>
      ) : null}
    </div>
  );
}
