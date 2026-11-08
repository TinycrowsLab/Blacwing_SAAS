 
'use client';

// Emergency stop links (design 3b): an administrator creates a time-limited link someone without a login (the SOC, an
// on-call engineer) can open to stop all testing. Created in Settings or from the Stop dialog; the link shows once, to
// copy. Settings also lists the links that still work (revoke) and the optional emergency contact the expired-link
// page shows.
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { buttonClass, Icon, INPUT_CLASS, InlineMessage } from './design';
import { CopyField, PendingButton } from './design-client';
import { LocalTime } from './results/local-time';
import {
  createEmergencyLinkAction,
  revokeEmergencyLinkAction,
  setEmergencyContactAction,
  type EmergencyValidity,
} from '../../app/(console)/settings/emergency-actions';

import type { EmergencyContact, EmergencyLink } from '../../lib/schemas';

const VALIDITIES: readonly { key: EmergencyValidity; label: string }[] = [
  { key: '1h', label: '1 hour' },
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
];
const LABEL_MAX = 80;
const NAME_MAX = 80;
const PHONE = /^\+?[0-9][0-9 ()./-]{2,38}$/;

/** Choose how long the link works and who it is for, create it, copy it. */
export function EmergencyLinkCreator() {
  const router = useRouter();
  const [validity, setValidity] = useState<EmergencyValidity>('24h');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ url: string; link: EmergencyLink } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (created !== null)
    return (
      <div className="flex flex-col gap-2.5">
        <CopyField value={created.url} label="Emergency stop link" copyLabel="Copy link" />
        <InlineMessage tone="gold">
          Copy it now: Blackwing keeps only a fingerprint of it, so it can&rsquo;t be shown again. It works until{' '}
          <b>
            <LocalTime iso={created.link.expiresAt} style="datetime" />
          </b>
          , with no login.
        </InlineMessage>
        <div>
          <button
            type="button"
            onClick={() => {
              setCreated(null);
              setLabel('');
            }}
            className={buttonClass('ghost', 'h-9 px-3 text-[13px]')}
          >
            <Icon name="plus" size={14} />
            Create another
          </button>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span id="el-validity" className="text-[13px] font-medium text-foreground">
          Works for
        </span>
        <div
          role="radiogroup"
          aria-labelledby="el-validity"
          className="inline-grid w-full grid-cols-3 gap-1 rounded-[10px] bg-surface-2 p-1 sm:w-auto sm:self-start"
        >
          {VALIDITIES.map((v) => (
            <button
              key={v.key}
              type="button"
              role="radio"
              aria-checked={validity === v.key}
              onClick={() => {
                setValidity(v.key);
              }}
              className={`inline-flex h-9 items-center justify-center whitespace-nowrap rounded-[7px] px-2 text-[13px] sm:px-4 font-medium focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${validity === v.key ? 'bg-card text-foreground shadow-[0_1px_2px_rgba(31,23,4,.08)]' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="el-label" className="text-[13px] font-medium text-foreground">
          Who it is for <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <div className="flex flex-wrap items-start gap-2">
          <input
            id="el-label"
            value={label}
            maxLength={LABEL_MAX}
            placeholder="For example, the security on-call"
            onChange={(e) => {
              setLabel(e.target.value);
              setError(null);
            }}
            className={`${INPUT_CLASS} min-w-0 flex-1 basis-56`}
          />
          <PendingButton
            pendingLabel="Creating…"
            icon="key"
            className="h-11 max-sm:w-full max-sm:justify-center"
            onAction={async () => {
              const r = await createEmergencyLinkAction(validity, label);
              if (!r.ok) {
                setError(r.message);
                return;
              }
              setCreated({ url: `${window.location.origin}/emergency/${r.data.token}`, link: r.data.link });
              router.refresh();
            }}
          >
            Create link
          </PendingButton>
        </div>
      </div>
      {error === null ? (
        <span className="text-[12.5px] text-muted-foreground">
          Anyone with the link can stop every audit in this workspace until it expires. Creating it is recorded in the
          ledger.
        </span>
      ) : (
        <InlineMessage tone="bad">{error}</InlineMessage>
      )}
    </div>
  );
}

/** The links that still work, newest first, each with Revoke. */
export function EmergencyLinkList({ links }: { readonly links: readonly EmergencyLink[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  if (links.length === 0)
    return <p className="m-0 text-[13px] text-muted-foreground">No emergency link works right now.</p>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {links.map((l) => (
          <li
            key={l.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[12px] border border-border bg-card px-3.5 py-3"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13.5px] font-semibold text-foreground">{l.label ?? 'No recipient named'}</span>
              <span className="text-[12.5px] text-muted-foreground">
                Works until <LocalTime iso={l.expiresAt} style="datetime" /> · created by {l.createdBy.name}
                {l.lastUsedAt === null ? null : <LocalTime iso={l.lastUsedAt} style="datetime" prefix=" · used " />}
              </span>
            </span>
            <PendingButton
              variant="secondary"
              pendingLabel="Revoking…"
              className="h-9 px-3.5 text-[13px]"
              onAction={async () => {
                const r = await revokeEmergencyLinkAction(l.id);
                setError(r.ok ? null : r.message);
                router.refresh();
              }}
            >
              Revoke
            </PendingButton>
          </li>
        ))}
      </ul>
      {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
    </div>
  );
}

/** The optional contact an expired link's page shows. Nothing is shown there until an administrator sets one. */
export function EmergencyContactForm({
  current,
  canEdit,
}: {
  readonly current: EmergencyContact | null;
  readonly canEdit: boolean;
}) {
  const router = useRouter();
  // What the server holds now: the form compares against it, so a saved form never looks dirty.
  const [saved, setSaved] = useState(current);
  const [name, setName] = useState(current?.name ?? '');
  const [phone, setPhone] = useState(current?.phone ?? '');
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'saved' } | { kind: 'failed'; message: string }>({
    kind: 'idle',
  });
  const changed = name.trim() !== (saved?.name ?? '') || phone.trim() !== (saved?.phone ?? '');
  const invalid =
    name.trim() === '' || phone.trim() === ''
      ? 'Give a name and a phone number.'
      : PHONE.test(phone.trim())
        ? null
        : 'Use digits, spaces and + ( ) - . only.';

  async function save(contact: EmergencyContact | null): Promise<void> {
    const r = await setEmergencyContactAction(contact);
    if (!r.ok) {
      setState({ kind: 'failed', message: r.message });
      return;
    }
    setSaved(contact);
    setName(contact?.name ?? '');
    setPhone(contact?.phone ?? '');
    setState({ kind: 'saved' });
    router.refresh();
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
      }}
      className="flex flex-col gap-2"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ec-name" className="text-[13px] font-medium text-foreground">
            Contact name
          </label>
          <input
            id="ec-name"
            value={name}
            disabled={!canEdit}
            maxLength={NAME_MAX}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              setState({ kind: 'idle' });
            }}
            className={`${INPUT_CLASS} w-full`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="ec-phone" className="text-[13px] font-medium text-foreground">
            Phone
          </label>
          <input
            id="ec-phone"
            type="tel"
            value={phone}
            disabled={!canEdit}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => {
              setPhone(e.target.value);
              setState({ kind: 'idle' });
            }}
            className={`${INPUT_CLASS} w-full`}
          />
        </div>
      </div>
      <div aria-live="polite" className="flex flex-col gap-1">
        {state.kind === 'failed' ? <InlineMessage tone="bad">{state.message}</InlineMessage> : null}
        {state.kind === 'saved' ? <InlineMessage tone="ok">Saved. The change is recorded in the ledger.</InlineMessage> : null}
        {state.kind === 'idle' && changed && invalid !== null ? <InlineMessage tone="bad">{invalid}</InlineMessage> : null}
        {state.kind === 'idle' && !(changed && invalid !== null) ? (
          <span className="text-[12.5px] text-muted-foreground">
            {canEdit
              ? 'Shown on an expired emergency link, so whoever opens it knows whom to call. Leave it empty to show no one.'
              : 'Only an administrator can set the emergency contact.'}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <PendingButton
          type="submit"
          pendingLabel="Saving…"
          variant={changed && invalid === null ? 'primary' : 'secondary'}
          disabled={!canEdit || !changed || invalid !== null}
          className="h-10"
          onAction={() => save({ name: name.trim(), phone: phone.trim() })}
        >
          Save contact
        </PendingButton>
        {saved === null ? null : (
          <PendingButton
            variant="ghost"
            pendingLabel="Removing…"
            disabled={!canEdit}
            className="h-10"
            onAction={() => save(null)}
          >
            Remove
          </PendingButton>
        )}
      </div>
    </form>
  );
}
