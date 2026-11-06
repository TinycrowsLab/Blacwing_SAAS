'use client';

// "Is {host} yours?" (experience spec §3.3 question 2): two whole-card choices. The file is checked by the API (the
// only request that reaches the site before Gate 1, and only when asked); the attestation is one tick that composes
// the statement for the person. Shared by the order and Targets.
import { type ReactNode, useState } from 'react';

import { dayLabel, isVerified, originOf } from './shared';
import { verifyTargetAction } from '../../../app/(console)/audits/actions';
import { Icon, InlineMessage } from '../design';
import { CopyField, PendingButton } from '../design-client';

import type { Asset } from '../../../lib/schemas';

export type ProofMethod = 'file' | 'attest';

/** "Confirmed by Jatin Singh: authorised to test https://x.example." (sent as owner_attestation). */
export const attestationStatement = (name: string, origin: string): string =>
  `Confirmed by ${name}: authorised to test ${origin}.`;

/** The API says "{url} did not answer 200 with the verification token."; the sentence around it already names the URL. */
function failureDetail(message: string, url: string): string {
  const rest = message.startsWith(url) ? `it ${message.slice(url.length).trim()}` : message;
  return rest.replace(/\.$/, '');
}

/** Sends the attestation; the order's Continue and Targets' Confirm both use it. */
export async function attest(
  asset: Asset,
  viewerName: string,
): Promise<{ asset: Asset } | { error: string }> {
  const r = await verifyTargetAction(asset.id, {
    method: 'owner_attestation',
    statement: attestationStatement(viewerName, originOf(asset)),
  });
  return r.ok ? { asset: r.data } : { error: r.message };
}

function ChoiceCard({
  name,
  checked,
  onPick,
  title,
  badge,
  line,
  index,
  children,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly onPick: () => void;
  readonly title: ReactNode;
  readonly badge?: ReactNode;
  readonly line: ReactNode;
  readonly index?: number | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <div
      className={`rounded-[14px] border transition-colors ${checked ? 'border-gold-ink bg-card' : 'border-border bg-card hover:border-border-strong'}`}
    >
      <label className="flex min-h-16 cursor-pointer gap-3 rounded-[14px] p-4 has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-focus">
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onPick}
          className="mt-0.5 size-[18px] shrink-0 accent-[var(--gold-ink)] focus-visible:outline-none"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-semibold leading-5 text-foreground">{title}</span>
            {badge}
          </span>
          <span className="text-[13px] leading-5 text-muted-foreground">{line}</span>
        </span>
        {index === undefined ? null : (
          <kbd className="hidden h-[18px] min-w-[18px] items-center justify-center self-start rounded-[5px] border border-current px-1 font-mono text-[10.5px] text-muted-foreground opacity-60 sm:inline-flex">
            {index}
          </kbd>
        )}
      </label>
      {checked && children !== undefined ? (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:pl-[46px]">{children}</div>
      ) : null}
    </div>
  );
}

export function VerifyOwnership({
  asset,
  viewerName,
  method,
  onMethod,
  attested,
  onAttested,
  onVerified,
  confirmButton = false,
  showIndex = false,
}: {
  /** Null while the site is being registered: the file rows show placeholders. */
  readonly asset: Asset | null;
  readonly viewerName: string;
  readonly method: ProofMethod;
  readonly onMethod: (m: ProofMethod) => void;
  readonly attested: boolean;
  readonly onAttested: (on: boolean) => void;
  readonly onVerified: (asset: Asset) => void;
  /** Targets: a Confirm button under the tick (the order's Continue does it there). */
  readonly confirmButton?: boolean;
  readonly showIndex?: boolean;
}) {
  const [checked, setChecked] = useState<{ ok: boolean; message: string } | null>(null);
  const [attestError, setAttestError] = useState<string | null>(null);

  if (asset !== null && isVerified(asset))
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-[14px] border border-border bg-ok-soft px-4 py-3.5"
      >
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-ok text-white">
          <Icon name="check" size={12} />
        </span>
        <span className="text-[13.5px] leading-5 text-foreground">
          <b className="font-semibold">
            {checked?.ok === true
              ? 'Found it. The site is verified as yours.'
              : 'The site is verified as yours.'}
          </b>{' '}
          <span className="text-muted-foreground">
            {asset.ownership.method === 'http_token' ? 'File found on the site' : 'Confirmed'}
            {asset.ownership.verifiedBy === null ? '' : ` by ${asset.ownership.verifiedBy}`}
            {asset.ownership.verifiedAt === null ? '' : `, ${dayLabel(asset.ownership.verifiedAt)}`}
            .
          </span>
        </span>
      </div>
    );

  const url = asset?.verification?.wellKnownUrl ?? null;
  const path = url === null ? null : new URL(url).pathname;
  const token = asset?.verification?.token ?? null;
  const origin = asset === null ? '' : originOf(asset);

  const check = async (): Promise<void> => {
    if (asset === null) return;
    setChecked(null);
    const r = await verifyTargetAction(asset.id, { method: 'http_token' });
    if (r.ok) {
      setChecked({ ok: true, message: 'Found it. The site is verified as yours.' });
      onVerified(r.data);
    } else {
      setChecked({
        ok: false,
        message:
          r.code === 'verification_failed' && url !== null
            ? `We fetched ${url} and didn't find the token (${failureDetail(r.message, url)}). Check that it's served at the site root, then try again.`
            : r.message,
      });
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="How to show the site is yours"
      className="flex flex-col gap-3"
    >
      <ChoiceCard
        name="proof"
        checked={method === 'file'}
        onPick={() => {
          onMethod('file');
        }}
        title="Put a file on the site"
        badge={
          <span className="inline-flex h-5 items-center rounded-md bg-gold-soft px-2 text-[11px] font-semibold text-gold-ink">
            Recommended
          </span>
        }
        line="Anyone can check it, and it proves you control the server."
        index={showIndex ? 1 : undefined}
      >
        <div className="grid items-center gap-x-3 gap-y-1.5 sm:grid-cols-[124px_minmax(0,1fr)]">
          <span className="text-[12.5px] text-muted-foreground">1. Create the file</span>
          {path === null ? (
            <div className="h-10 rounded-[10px] bg-surface-2" />
          ) : (
            <CopyField value={path} />
          )}
          <span className="mt-1.5 text-[12.5px] text-muted-foreground sm:mt-0">
            2. Paste this in it
          </span>
          {token === null ? (
            <div className="h-10 rounded-[10px] bg-surface-2" />
          ) : (
            <CopyField value={token} />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <PendingButton
              variant="secondary"
              onAction={check}
              pendingLabel="Looking for the file…"
              disabled={asset === null}
              icon="search"
            >
              Check now
            </PendingButton>
            <span className="text-[12px] text-muted-foreground">
              Served as plain text at the site root.
            </span>
          </div>
          {checked === null || checked.ok ? null : (
            <InlineMessage tone="bad">{checked.message}</InlineMessage>
          )}
        </div>
      </ChoiceCard>
      <ChoiceCard
        name="proof"
        checked={method === 'attest'}
        onPick={() => {
          onMethod('attest');
        }}
        title="I'm responsible for this system"
        line="For internal hosts and labs that can't serve a file. You confirm in one tick, and it's recorded with your name."
        index={showIndex ? 2 : undefined}
      >
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] border border-border bg-surface-2 px-3.5 py-3 text-[13.5px] text-foreground has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-focus">
          <input
            type="checkbox"
            checked={attested}
            onChange={(e) => {
              onAttested(e.target.checked);
              setAttestError(null);
            }}
            className="mt-0.5 size-[18px] shrink-0 accent-[var(--gold-ink)] focus-visible:outline-none"
          />
          <span className="min-w-0 break-words">
            I&apos;m authorised to test <b className="font-semibold">{origin}</b>.
          </span>
        </label>
        <span className="text-[12px] text-muted-foreground">
          Recorded as &ldquo;{attestationStatement(viewerName, origin)}&rdquo;
        </span>
        {confirmButton && asset !== null ? (
          <div>
            <PendingButton
              variant="secondary"
              disabled={!attested}
              {...(attested ? {} : { title: 'Tick the box first' })}
              pendingLabel="Recording…"
              onAction={async () => {
                const r = await attest(asset, viewerName);
                if ('error' in r) setAttestError(r.error);
                else onVerified(r.asset);
              }}
            >
              Confirm
            </PendingButton>
          </div>
        ) : null}
        {attestError === null ? null : <InlineMessage tone="bad">{attestError}</InlineMessage>}
      </ChoiceCard>
    </div>
  );
}
