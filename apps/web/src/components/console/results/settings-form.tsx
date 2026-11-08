'use client';

// Settings (experience spec §2, §8): the workspace name, editable (2 to 60 characters, checked as you type and on
// Enter, runs of spaces folded to one, saved through the same action /welcome uses), and the theme. The
// administrator's settings are read-only on the page.
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { nameWorkspaceAction } from '../../../app/welcome/actions';
import {
  tidyWorkspaceName,
  WORKSPACE_NAME_MAX,
  WORKSPACE_NAME_MIN,
  workspaceNameError,
} from '../../../lib/workspace-name';
import { buttonClass, Icon, INPUT_CLASS, InlineMessage } from '../design';
import { PendingButton } from '../design-client';
import { useThemeChoice } from '../theme-toggle';
import { useSettledAction } from './triage';

const HTTP_BAD_REQUEST = 400;

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
  const [saved, setSaved] = useState(tidyWorkspaceName(current));
  const [name, setName] = useState(tidyWorkspaceName(current));
  const [touched, setTouched] = useState(false);
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'saved' } | { kind: 'failed'; message: string }
  >({
    kind: 'idle',
  });
  const invalid = workspaceNameError(tidyWorkspaceName(name));
  const changed = tidyWorkspaceName(name) !== saved;
  // The error shows as soon as an edit makes the name invalid, and on Enter or leaving the field.
  const showError = (touched || changed) && invalid !== null;

  async function save(): Promise<boolean> {
    setTouched(true);
    if (invalid !== null) {
      input.current?.focus();
      return false;
    }
    if (!changed) return false;
    const result = await nameWorkspaceAction(tidyWorkspaceName(name));
    if (!result.ok) {
      // The server's own wording for a rejected body is for developers; the person gets the rule instead.
      const message =
        result.status === HTTP_BAD_REQUEST
          ? `That name can't be saved. Use ${WORKSPACE_NAME_MIN} to ${WORKSPACE_NAME_MAX} characters.`
          : result.message;
      setState({ kind: 'failed', message });
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
            // An invalid field keeps a red ring while focused, so the error never reads as gold.
            className={`${INPUT_CLASS} w-full aria-[invalid=true]:focus-visible:border-bad aria-[invalid=true]:focus-visible:ring-bad/25`}
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
                  ? `${WORKSPACE_NAME_MIN} to ${WORKSPACE_NAME_MAX} characters. The change is recorded in the ledger.`
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
  const [choice, setChoice] = useThemeChoice();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div
        role="radiogroup"
        aria-label="Theme"
        className="inline-grid grid-cols-3 gap-1 rounded-[10px] bg-surface-2 p-1"
      >
        {[
          { key: 'light' as const, label: 'Light', icon: 'sun' as const },
          { key: 'dark' as const, label: 'Dark', icon: 'moon' as const },
          { key: 'system' as const, label: 'System', icon: 'monitor' as const },
        ].map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={choice === o.key}
            onClick={() => {
              setChoice(o.key);
            }}
            className={`inline-flex h-9 items-center gap-1.5 rounded-[7px] px-4 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${choice === o.key ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(31,23,4,.08)]' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Icon name={o.icon} size={14} />
            {o.label}
          </button>
        ))}
      </div>
      <span className="text-[12.5px] text-muted-foreground">Saved on this device. System follows your device.</span>
    </div>
  );
}

/** Re-reads the page from the server (Retry, Check again): says so while it works. */
export function RefreshButton({
  label = 'Retry',
  busyLabel = 'Retrying…',
  className = 'font-medium underline',
}: {
  readonly label?: string;
  readonly busyLabel?: string;
  readonly className?: string;
}) {
  const router = useRouter();
  // Settles when React has committed the refreshed page (not when a render that may still suspend has run).
  const { settling: busy, run } = useSettledAction();
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy || undefined}
      className={className}
      onClick={() => {
        void run(() => {
          router.refresh();
          return Promise.resolve();
        });
      }}
    >
      {busy ? busyLabel : label}
    </button>
  );
}

export const RetryButton = () => <RefreshButton />;
