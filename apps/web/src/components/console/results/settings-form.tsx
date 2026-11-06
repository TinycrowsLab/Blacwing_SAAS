'use client';

// Settings (experience spec §2, §8): the workspace name, editable (2 to 60 characters, checked as you type and on
// Enter, runs of spaces folded to one, saved through the same action /welcome uses), and the theme. The
// administrator's settings are read-only on the page.
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { nameWorkspaceAction } from '../../../app/welcome/actions';
import { WORKSPACE_NAME_MAX, workspaceNameError } from '../../../lib/workspace-name';
import { buttonClass, Icon, INPUT_CLASS, InlineMessage } from '../design';
import { PendingButton } from '../design-client';
import { useDarkTheme } from '../theme-toggle';

/** "  Tinycrows   Security " is saved as "Tinycrows Security". */
const tidy = (name: string): string => name.trim().replace(/\s+/g, ' ');
/** The shared check, with the upper bound said exactly (60 itself is allowed). */
const nameError = (name: string): string | null =>
  name.length > WORKSPACE_NAME_MAX
    ? `Keep it to ${WORKSPACE_NAME_MAX} characters or fewer.`
    : workspaceNameError(name);

export function WorkspaceNameForm({
  current,
  canEdit,
}: {
  readonly current: string;
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  // A name stored untidied (from an older form) opens tidied and unchanged: a pristine page never looks dirty.
  const [saved, setSaved] = useState(tidy(current));
  const [name, setName] = useState(tidy(current));
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'saved' } | { kind: 'failed'; message: string }
  >({
    kind: 'idle',
  });
  const invalid = nameError(tidy(name));
  const changed = tidy(name) !== saved;
  // The error shows as soon as an edit makes the name invalid, and on Enter or leaving the field.
  const showError = (touched || changed) && invalid !== null;

  async function save(): Promise<boolean> {
    setTouched(true);
    if (invalid !== null) {
      input.current?.focus();
      return false;
    }
    if (!changed) return false;
    const result = await nameWorkspaceAction(tidy(name));
    if (!result.ok) {
      setState({ kind: 'failed', message: result.message });
      return false;
    }
    setSaved(result.data.name);
    setName(result.data.name);
    setState({ kind: 'saved' });
    window.dispatchEvent(new Event('bw:refresh'));
    router.refresh();
    return true;
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        // Enter clicks the submit button, whose PendingButton runs `save` once.
        e.preventDefault();
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor="ws-name" className="text-[13px] font-medium text-foreground">
        Workspace name
      </label>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
          <input
            ref={input}
            id="ws-name"
            value={name}
            disabled={!canEdit}
            autoComplete="organization"
            maxLength={WORKSPACE_NAME_MAX * 2}
            aria-invalid={showError}
            aria-describedby="ws-name-help"
            onChange={(e) => {
              setName(e.target.value);
              setState({ kind: 'idle' });
            }}
            onBlur={() => {
              setTouched(true);
            }}
            className={`${INPUT_CLASS} w-full`}
          />
          {/* Directly under the field at every width, so the message sits next to what it describes. */}
          <div id="ws-name-help" aria-live="polite" className="flex flex-col gap-1">
            {showError ? <InlineMessage tone="bad">{invalid}</InlineMessage> : null}
            {state.kind === 'failed' ? (
              <InlineMessage tone="bad">{state.message}</InlineMessage>
            ) : null}
            {state.kind === 'saved' ? (
              <InlineMessage tone="ok">
                Saved. Everyone in the workspace sees the new name.
              </InlineMessage>
            ) : null}
            {state.kind === 'idle' && !showError ? (
              <span className="text-[12.5px] text-muted-foreground">
                {canEdit
                  ? '2 to 60 characters. The change is recorded in the ledger.'
                  : 'Only an administrator can rename the workspace.'}
              </span>
            ) : null}
          </div>
        </div>
        <PendingButton
          type="submit"
          variant={changed && invalid === null ? 'primary' : 'secondary'}
          // Enabled while invalid, so Enter or a click explains what to fix instead of doing nothing.
          disabled={!canEdit || (!changed && invalid === null)}
          pendingLabel="Saving…"
          stayPending
          onAction={async () => {
            await save();
            return false;
          }}
          className="h-11"
        >
          Save
        </PendingButton>
        {changed ? (
          <button
            type="button"
            className={buttonClass('ghost', 'h-11')}
            onClick={() => {
              setName(saved);
              setTouched(false);
              setState({ kind: 'idle' });
            }}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function ThemeSetting() {
  const [dark, toggle] = useDarkTheme();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div
        role="radiogroup"
        aria-label="Theme"
        className="inline-grid grid-cols-2 gap-1 rounded-[10px] bg-surface-2 p-1"
      >
        {[
          { key: false, label: 'Light', icon: 'sun' as const },
          { key: true, label: 'Dark', icon: 'moon' as const },
        ].map((o) => (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={dark === o.key}
            onClick={() => {
              if (dark !== o.key) toggle();
            }}
            className={`inline-flex h-9 items-center gap-1.5 rounded-[7px] px-4 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${dark === o.key ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(31,23,4,.08)]' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Icon name={o.icon} size={14} />
            {o.label}
          </button>
        ))}
      </div>
      <span className="text-[12.5px] text-muted-foreground">Saved on this device.</span>
    </div>
  );
}

export function RetryButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="font-medium underline"
      onClick={() => {
        router.refresh();
      }}
    >
      Retry
    </button>
  );
}
