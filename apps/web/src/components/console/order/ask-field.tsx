'use client';

// "What should we audit?" (experience spec §3.2, §10.1): one forgiving field. What was typed becomes an origin, every
// change is said out loud as a chip, and a site already added is recognised. Never type="url", so no native popups.
import Link from 'next/link';
import { type ReactNode, useEffect, useState } from 'react';
import { z } from 'zod';

import { dayLabel, isVerified } from './shared';
import { normalizeTarget, type Note, type TargetResult } from '../../../lib/normalize';
import { type Asset, assetSchema } from '../../../lib/schemas';
import { Icon } from '../design';

const DEBOUNCE_MS = 150;
const listSchema = z.object({ items: z.array(assetSchema) });

/** The normalised target, recomputed 150 ms after the last keystroke. */
export function useNormalized(text: string): TargetResult {
  const [result, setResult] = useState(() => normalizeTarget(text));
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setResult(normalizeTarget(text));
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [text]);
  return result;
}

/** The workspace's targets (for "You already added this site"); null until loaded or when unavailable. */
export function useKnownTargets(initial: readonly Asset[] | null = null): readonly Asset[] | null {
  const [known, setKnown] = useState<readonly Asset[] | null>(initial);
  useEffect(() => {
    if (initial !== null) return;
    const ctrl = new AbortController();
    fetch('/api/assets', { signal: ctrl.signal, cache: 'no-store' })
      .then(async (r) => (r.ok ? listSchema.parse(await r.json()).items : null))
      .then(setKnown)
      .catch(() => null);
    return () => {
      ctrl.abort();
    };
  }, [initial]);
  return known;
}

export function findKnown(known: readonly Asset[] | null, origin: string): Asset | undefined {
  return known?.find((a) => {
    try {
      return new URL(a.baseUrl).origin === origin;
    } catch {
      return false;
    }
  });
}

function NoteChip({ note }: { readonly note: Note }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-md bg-surface-2 px-2 text-[11.5px] text-muted-foreground">
      {note.text.trim()}
      {note.code === undefined ? null : <code className="font-mono text-[11px] text-foreground">{note.code}</code>}
      {note.after?.trim()}
    </span>
  );
}

/** A plan waiting for Gate 1: its id and its site. */
export interface WaitingPlan {
  readonly id: string;
  readonly assetId: string;
}

/** The live line under the field: what we understood, or the one fix. */
export function TargetLine({
  result,
  known,
  showError,
  waiting = [],
}: {
  readonly result: TargetResult;
  readonly known: readonly Asset[] | null;
  readonly showError: boolean;
  readonly waiting?: readonly WaitingPlan[];
}) {
  if (!result.ok) {
    if (result.empty === true || !showError) return null;
    return (
      <p role="alert" className="m-0 flex items-start gap-2 text-[13px] leading-5 text-bad">
        <Icon name="warn" size={15} className="mt-[2px]" />
        {result.message}
      </p>
    );
  }
  const existing = findKnown(known, result.origin);
  const plan = existing === undefined ? undefined : waiting.find((w) => w.assetId === existing.id);
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 flex items-start gap-2 text-[13.5px] leading-5 text-muted-foreground">
        <span className="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-ok-soft text-ok">
          <Icon name="check" size={11} />
        </span>
        <span className="min-w-0 break-words">
          Understood as <b className="font-semibold text-foreground">{result.display}</b>. We audit the whole site, not
          just one page.
        </span>
      </p>
      {result.notes.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5 pl-[26px]">
          {result.notes.map((n) => (
            <NoteChip key={`${n.text}${n.code ?? ''}`} note={n} />
          ))}
        </div>
      )}
      {existing === undefined ? null : (
        <p className="m-0 pl-[26px] text-[12.5px] text-gold-ink">
          {isVerified(existing) && existing.ownership.verifiedAt !== null
            ? `You already added this site, verified ${dayLabel(existing.ownership.verifiedAt)}.`
            : "You already added this site. It isn't verified yet."}
        </p>
      )}
      {plan === undefined ? null : (
        <p className="m-0 pl-[26px] text-[12.5px] text-foreground">
          A plan for this site is already waiting for your approval.{' '}
          <Link href={`/audits/${plan.id}`} className="font-semibold text-gold-ink underline underline-offset-2">
            Open that plan
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * The field itself. `hero` is Home's large card (the button sits inside it); `plain` is the order's and Targets' field.
 * Enter calls `onEnter`; the parent decides what to do with the normalised result.
 */
export function AskField({
  id,
  label,
  text,
  onText,
  result,
  known,
  showError,
  onBlur,
  onEnter,
  action,
  variant = 'plain',
  autoFocus = false,
  waiting,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly result: TargetResult;
  readonly known: readonly Asset[] | null;
  readonly showError: boolean;
  readonly onBlur?: () => void;
  readonly onEnter: () => void;
  readonly action?: ReactNode;
  readonly variant?: 'hero' | 'plain';
  readonly autoFocus?: boolean;
  readonly waiting?: readonly WaitingPlan[];
}) {
  const hero = variant === 'hero';
  const invalid = showError && !result.ok && result.empty !== true;
  return (
    <div
      className={`flex flex-col rounded-[18px] border bg-card transition-[border-color,box-shadow] focus-within:ring-[3px] ${invalid ? 'border-bad focus-within:border-bad focus-within:ring-bad-soft' : 'border-input-strong focus-within:border-gold-ink focus-within:ring-focus'} ${hero ? 'shadow-[0_8px_28px_rgba(31,23,4,.06)]' : ''}`}
    >
      <label htmlFor={id} className="px-4 pt-3.5 text-[12.5px] font-medium text-muted-foreground sm:px-5">
        {label}
      </label>
      <div className="flex items-center gap-3 px-4 pb-3 pt-1.5 sm:px-5">
        <Icon name="web" size={20} className="hidden shrink-0 text-muted-foreground sm:block" />
        <input
          id={id}
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="url"
          spellCheck={false}
          autoFocus={autoFocus}
          value={text}
          placeholder="Paste a web address, like app.yourcompany.com"
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-line`}
          onChange={(e) => {
            onText(e.target.value);
          }}
          onBlur={onBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter();
            }
          }}
          className={`min-w-0 flex-1 bg-transparent text-foreground placeholder:text-muted-foreground focus:outline-none ${hero ? 'h-12 text-[17px] sm:text-[19px]' : 'h-11 text-[16px]'}`}
        />
        {action === undefined ? null : <span className="hidden shrink-0 sm:block">{action}</span>}
      </div>
      <div
        id={`${id}-line`}
        aria-live="polite"
        className={`border-t border-dashed border-border px-4 py-3 sm:px-5 ${!result.ok && (result.empty === true || !showError) ? 'hidden' : ''}`}
      >
        <TargetLine result={result} known={known} showError={showError} {...(waiting === undefined ? {} : { waiting })} />
      </div>
      {action === undefined ? null : <div className="px-4 pb-4 sm:hidden">{action}</div>}
    </div>
  );
}
