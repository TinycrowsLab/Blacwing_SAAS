/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel and timing values, see design/README.md */
'use client';

// Interactive primitives of the experience spec (§10.4, §6.2, §10.2, §10.3). Server-safe primitives are in ./design.
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { buttonClass, Icon, InlineMessage, type ButtonVariant, type IconName, Kbd } from './design';
import { useNow } from './use-now';
import { REASON_MIN, reasonChars } from '../../lib/normalize';

const SLOW_MS = 2000;

/**
 * A button that never loses a click (spec §10.4). It shows `pendingLabel` with a spinner from pointerdown (or
 * Enter/Space), locks its width, ignores repeated activations while `onAction` runs, and says "Still working…" after
 * 2 s. It resets when `onAction` settles, unless `stayPending` and the action did not return `false` (use it when the
 * action navigates away, so the button does not flicker back before the next page shows).
 */
export function PendingButton({
  onAction,
  children,
  pendingLabel,
  variant = 'primary',
  className = '',
  disabled = false,
  stayPending = false,
  icon,
  shortcut,
  title,
  autoFocus,
  type = 'button',
  describedBy,
}: {
  readonly onAction: () => unknown;
  readonly children: ReactNode;
  /** The verb in progress, e.g. "Approving…". */
  readonly pendingLabel: string;
  readonly variant?: ButtonVariant;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly stayPending?: boolean;
  readonly icon?: IconName;
  /** A key hint shown on the button (the page binds the key). */
  readonly shortcut?: string;
  readonly title?: string;
  readonly autoFocus?: boolean;
  readonly type?: 'button' | 'submit';
  readonly describedBy?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [minWidth, setMinWidth] = useState<number | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSlow(true);
    }, SLOW_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [pending]);

  const arm = (): void => {
    if (disabled || inFlight.current) return;
    setMinWidth(ref.current?.offsetWidth);
    setPending(true);
  };
  const disarm = (): void => {
    if (!inFlight.current) setPending(false);
  };
  const run = async (): Promise<void> => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    arm();
    setPending(true);
    let keep = false;
    try {
      // Always run the action; `stayPending` only decides whether the button resets afterwards.
      const result = await onAction();
      keep = stayPending && result !== false;
    } finally {
      if (!keep) {
        inFlight.current = false;
        if (mounted.current) setPending(false);
      }
    }
  };

  return (
    <button
      ref={ref}
      type={type}
      title={title}
      autoFocus={autoFocus}
      disabled={disabled}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      aria-describedby={describedBy}
      style={pending && minWidth !== undefined ? { minWidth } : undefined}
      onPointerDown={(e) => {
        if (e.button === 0) arm();
      }}
      onPointerLeave={disarm}
      onPointerCancel={disarm}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') arm();
      }}
      onClick={(e) => {
        if (type === 'button') e.preventDefault();
        void run();
      }}
      className={buttonClass(variant, `${pending ? 'cursor-progress' : ''} ${className}`)}
    >
      {pending ? (
        <>
          <span
            aria-hidden="true"
            className="size-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent motion-safe:animate-[bwspin_0.8s_linear_infinite]"
          />
          <span aria-live="polite">{slow ? 'Still working…' : pendingLabel}</span>
        </>
      ) : (
        <>
          {icon === undefined ? null : <Icon name={icon} size={16} />}
          {children}
          {shortcut === undefined ? null : <Kbd>{shortcut}</Kbd>}
        </>
      )}
    </button>
  );
}

/** Copies text to the clipboard, falling back to a hidden textarea where the async clipboard is unavailable. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the only copy path outside a secure context
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** A value with a Copy button ("Copied" for a moment). Used for the verification file path and token, links, curl. */
export function CopyField({
  value,
  label,
  mono = true,
  copyLabel = 'Copy',
}: {
  readonly value: string;
  readonly label?: ReactNode;
  readonly mono?: boolean;
  readonly copyLabel?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = window.setTimeout(() => {
      setState('idle');
    }, 1600);
    return () => {
      window.clearTimeout(timer);
    };
  }, [state]);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {label === undefined ? null : <span className="text-[12.5px] font-medium text-foreground">{label}</span>}
      <div className="flex min-w-0 items-center gap-2 rounded-[10px] border border-border bg-code py-1 pl-3 pr-1">
        <span
          className={`min-w-0 flex-1 select-all break-all py-1.5 text-[12.5px] leading-5 text-foreground ${mono ? 'font-mono' : ''}`}
        >
          {value}
        </span>
        <button
          type="button"
          onClick={() => {
            void copyText(value).then((ok) => {
              setState(ok ? 'copied' : 'failed');
            });
          }}
          className={buttonClass('secondary', 'h-8 shrink-0 rounded-lg px-3 text-[12.5px]')}
        >
          <Icon name={state === 'copied' ? 'check' : 'copy'} size={14} />
          <span aria-live="polite">
            {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select and copy' : copyLabel}
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * A decision reason (Gate 1, Gate 2 allow, Gate 3): at least 8 non-space characters, with a live counter that turns
 * into "Enough detail". Ctrl/Cmd+Enter calls `onSubmit`. Suggestions fill the field in one click.
 */
export function ReasonField({
  label,
  value,
  onChange,
  onSubmit,
  min = REASON_MIN,
  placeholder,
  suggestions = [],
  footnote = 'Kept on the ledger with your name',
  autoFocus,
  disabled = false,
  rows = 3,
}: {
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit?: () => void;
  readonly min?: number;
  readonly placeholder?: string;
  readonly suggestions?: readonly string[];
  readonly footnote?: ReactNode;
  readonly autoFocus?: boolean;
  readonly disabled?: boolean;
  readonly rows?: number;
}) {
  const id = useId();
  const n = reasonChars(value);
  const enough = n >= min;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px] font-medium text-foreground">
        {label}
      </label>
      {suggestions.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => {
                onChange(s);
              }}
              className="inline-flex h-7 items-center rounded-full border border-border bg-surface-2 px-3 text-[12px] text-foreground hover:border-gold-line hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      <textarea
        id={id}
        rows={rows}
        value={value}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-describedby={`${id}-count`}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmit !== undefined) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="w-full resize-y rounded-[10px] border border-input-strong bg-card px-3.5 py-2.5 text-[14px] leading-[21px] text-foreground placeholder:text-muted-foreground focus-visible:border-gold-ink focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus disabled:bg-surface-2"
      />
      <div id={`${id}-count`} className="flex items-center justify-between gap-3 text-[12px]" aria-live="polite">
        <span className="text-muted-foreground">{footnote}</span>
        {enough ? (
          <span className="inline-flex items-center gap-1 font-medium text-ok">
            <Icon name="check" size={12} />
            Enough detail
          </span>
        ) : (
          <span className="tabular-nums text-muted-foreground">
            {n} of {min} characters
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A list typed or pasted as chips (excluded paths, extra origins). `parse` turns text into the new list, e.g.
 * `(text, existing) => { const r = normalizePaths(text, origin, existing); return { values: r.paths, error: r.error }; }`.
 * Space, comma, Enter, paste and blur commit; Backspace on an empty field removes the last chip. `locked` chips (set
 * on the target) show with a lock and cannot be removed.
 */
export function ChipInput({
  label,
  values,
  onChange,
  parse,
  placeholder,
  locked = [],
  lockedNote = 'set on the target',
  describe,
}: {
  readonly label: ReactNode;
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
  readonly parse: (text: string, existing: readonly string[]) => { values: readonly string[]; error: string | null };
  readonly placeholder?: string;
  readonly locked?: readonly string[];
  readonly lockedNote?: string;
  /** How a chip reads, e.g. "/admin and everything under it". */
  readonly describe?: (value: string) => ReactNode;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const commit = (raw: string): void => {
    if (raw.trim() === '') return;
    const r = parse(raw, values);
    setError(r.error);
    if (r.values.length !== values.length || r.values.some((v, i) => v !== values[i])) onChange(r.values);
    setText('');
  };
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[13px] font-medium text-foreground">
        {label}
      </label>
      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-[10px] border border-input-strong bg-card px-2 py-1.5 focus-within:border-gold-ink focus-within:ring-[3px] focus-within:ring-focus">
        {locked.map((v) => (
          <span
            key={`locked-${v}`}
            title={lockedNote}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2 font-mono text-[12px] text-muted-foreground"
          >
            <Icon name="lock" size={12} />
            {describe?.(v) ?? v}
            <span className="font-sans text-[11px]">({lockedNote})</span>
          </span>
        ))}
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-gold-soft pl-2 pr-1 font-mono text-[12px] text-gold-ink"
          >
            {describe?.(v) ?? v}
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => {
                onChange(values.filter((x) => x !== v));
              }}
              className="flex size-5 items-center justify-center rounded hover:bg-gold-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          placeholder={values.length === 0 ? placeholder : undefined}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error !== null || undefined}
          onChange={(e) => {
            const next = e.target.value;
            if (/[\s,]$/.test(next)) commit(next);
            else {
              setText(next);
              if (error !== null) setError(null);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            commit(`${text}${e.clipboardData.getData('text')}`);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(text);
            } else if (e.key === 'Backspace' && text === '' && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => {
            commit(text);
          }}
          className="h-7 min-w-[120px] flex-1 bg-transparent px-1 text-[13.5px] text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
      {error === null || error === '' ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
    </div>
  );
}

/** "3:24" for 204 seconds. */
export const clockLabel = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * The live countdown to a server deadline (Gate 2): seconds left, the m:ss label, the tone (`warn` under 60 s,
 * `bad` under 15 s) and the remaining share of `deadlineAt − createdAt`. Null until mounted (no SSR mismatch).
 */
export function useCountdown(
  deadlineAt: string,
  createdAt?: string,
): { secondsLeft: number; label: string; tone: 'normal' | 'warn' | 'bad'; share: number | null } | null {
  const now = useNow();
  if (now === 0) return null;
  const deadline = Date.parse(deadlineAt);
  const secondsLeft = Math.max(0, Math.ceil((deadline - now) / 1000));
  const total = createdAt === undefined ? Number.NaN : deadline - Date.parse(createdAt);
  return {
    secondsLeft,
    label: clockLabel(secondsLeft),
    tone: secondsLeft < 15 ? 'bad' : secondsLeft < 60 ? 'warn' : 'normal',
    share: Number.isFinite(total) && total > 0 ? Math.max(0, Math.min(1, (deadline - now) / total)) : null,
  };
}

const CLOCK_TONE = { normal: 'text-gold-ink', warn: 'text-warn', bad: 'text-bad' } as const;

/**
 * `inline`: "3:24 left" (gold, then warn and bad); `big`: the 64 px phone clock; `bar`: the 3 px remaining-time bar.
 * The label is announced politely once a minute, not every second.
 */
export function Countdown({
  deadlineAt,
  createdAt,
  variant = 'inline',
  suffix = 'left',
  className = '',
}: {
  readonly deadlineAt: string;
  readonly createdAt?: string;
  readonly variant?: 'inline' | 'big' | 'bar';
  readonly suffix?: string;
  readonly className?: string;
}) {
  const c = useCountdown(deadlineAt, createdAt);
  if (variant === 'bar') {
    const pct = c?.share === null || c === null ? 100 : c.share * 100;
    return (
      <div aria-hidden="true" className={`h-[3px] w-full bg-gold-line ${className}`}>
        <div
          className={`h-full ${c?.tone === 'bad' ? 'bg-bad' : c?.tone === 'warn' ? 'bg-warn' : 'bg-gold-ink'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  }
  const label = c === null ? '–:––' : c.label;
  const tone = c === null ? CLOCK_TONE.normal : CLOCK_TONE[c.tone];
  if (variant === 'big')
    return (
      <span className={`text-[64px] font-semibold leading-[72px] tracking-[-0.02em] tabular-nums ${tone} ${className}`}>
        {label}
      </span>
    );
  return (
    <span className={`font-semibold tabular-nums ${tone} ${className}`}>
      {label}
      {suffix === '' ? null : ` ${suffix}`}
    </span>
  );
}
