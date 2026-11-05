'use client';

// The one field of the first run: the workspace name, prefilled from the Google account, checked as you type.
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { nameWorkspaceAction } from './actions';
import { Icon, INPUT_CLASS, InlineMessage } from '../../components/console/design';
import { PendingButton } from '../../components/console/design-client';
import { workspaceNameError } from '../../lib/workspace-name';

export function WelcomeForm({
  proposed,
  domain,
}: {
  readonly proposed: string;
  /** The domain the name came from; null when it came from the person's name (consumer address). */
  readonly domain: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState(proposed);
  const [touched, setTouched] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const invalid = workspaceNameError(name);

  async function create(): Promise<boolean> {
    setTouched(true);
    if (invalid !== null) return false;
    setFailure(null);
    const result = await nameWorkspaceAction(name);
    if (!result.ok) {
      setFailure(result.message);
      return false;
    }
    router.replace('/?named=1');
    return true;
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
      }}
      className="mt-8 flex flex-col rounded-[18px] border border-border bg-card px-5 pb-5 pt-[22px] sm:px-[22px]"
    >
      <label htmlFor="workspace-name" className="mb-2 text-[13px] font-medium text-foreground">
        Workspace name
      </label>
      <div className="relative">
        <input
          id="workspace-name"
          value={name}
          autoFocus
          autoComplete="organization"
          maxLength={80}
          aria-invalid={touched && invalid !== null}
          aria-describedby="workspace-name-help"
          onChange={(e) => {
            setName(e.target.value);
            setFailure(null);
          }}
          onBlur={() => {
            setTouched(true);
          }}
          className={`${INPUT_CLASS} h-[50px] pr-32 text-[17px]`}
        />
        {invalid === null ? (
          <span className="pointer-events-none absolute right-2.5 top-1/2 inline-flex h-6 -translate-y-1/2 items-center gap-1 rounded-md bg-ok-soft px-2 text-[12px] font-medium text-ok">
            <Icon name="check" size={12} />
            Looks good
          </span>
        ) : null}
      </div>
      <div id="workspace-name-help" className="mt-2.5 flex flex-col gap-1.5">
        {touched && invalid !== null ? <InlineMessage tone="bad">{invalid}</InlineMessage> : null}
        {failure === null ? null : <InlineMessage tone="bad">{failure}</InlineMessage>}
        <InlineMessage tone="gold">
          {domain === null ? (
            'Suggested from your Google account.'
          ) : (
            <>
              Suggested from your Google account (<b>{domain}</b>).
            </>
          )}{' '}
          You&apos;ll be its owner, and you can rename it any time in Settings.
        </InlineMessage>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <PendingButton
          type="submit"
          onAction={create}
          pendingLabel="Creating…"
          stayPending
          className="h-12 rounded-xl px-[22px] text-[14.5px]"
        >
          Create workspace
          <Icon name="arrow" size={16} />
        </PendingButton>
        <span className="text-[12.5px] text-muted-foreground">or press Enter</span>
      </div>
    </form>
  );
}
