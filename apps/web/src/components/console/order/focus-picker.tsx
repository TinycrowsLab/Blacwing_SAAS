'use client';

// "What should Claude look for?" (spec §3.3 question 3): chips with a one-line explanation, then optional free text.
// The objective is composed from them by a template (shared.ts composeObjective).
import { useId } from 'react';

import { FOCUS_CHIPS, type FocusKey, toggleFocus } from './shared';
import { Icon } from '../design';

export function FocusPicker({
  keys,
  onKeys,
  text,
  onText,
  onSubmit,
  showIndex = false,
}: {
  readonly keys: readonly FocusKey[];
  readonly onKeys: (keys: FocusKey[]) => void;
  readonly text: string;
  readonly onText: (text: string) => void;
  /** Ctrl/Cmd+Enter in the text box. */
  readonly onSubmit?: () => void;
  readonly showIndex?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="m-0 grid gap-2 border-0 p-0 sm:grid-cols-2">
        <legend className="sr-only">What to look for</legend>
        {FOCUS_CHIPS.map((c, i) => {
          const on = keys.includes(c.key);
          return (
            <label
              key={c.key}
              className={`flex min-h-[60px] cursor-pointer items-start gap-3 rounded-[12px] border px-3.5 py-3 transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-focus ${on ? 'border-gold-ink bg-gold-soft' : 'border-border bg-card hover:border-border-strong hover:bg-surface-2'}`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => {
                  onKeys(toggleFocus(keys, c.key, e.target.checked));
                }}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border ${on ? 'border-gold-ink bg-gold-ink text-bg' : 'border-input-strong bg-card'}`}
              >
                {on ? <Icon name="check" size={12} /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[14px] font-medium leading-5 text-foreground">{c.label}</span>
                <span className="text-[12.5px] leading-[18px] text-muted-foreground">{c.hint}</span>
              </span>
              {showIndex ? (
                <kbd className="hidden h-[18px] min-w-[18px] items-center justify-center rounded-[5px] border border-current px-1 font-mono text-[10.5px] text-muted-foreground opacity-60 sm:inline-flex">
                  {i + 1}
                </kbd>
              ) : null}
            </label>
          );
        })}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-[13px] font-medium text-foreground">
          Anything specific? <span className="font-normal text-muted-foreground">Optional</span>
        </label>
        <textarea
          id={id}
          rows={2}
          maxLength={1500}
          value={text}
          placeholder="For example: the checkout and the account pages matter most."
          onChange={(e) => {
            onText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && onSubmit !== undefined) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="w-full resize-y rounded-[10px] border border-input-strong bg-card px-3.5 py-2.5 text-[14px] leading-[21px] text-foreground placeholder:text-muted-foreground focus-visible:border-gold-ink focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
        />
      </div>
    </div>
  );
}
