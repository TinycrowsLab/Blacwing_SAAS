'use client';

// "Is {host} yours?" (experience spec §3.3 question 2): one attestation. The person ticks that they are authorised to
// test the site (they own it or hold written permission); the API records the statement, who and when. Shared by the
// order and Targets.
import { useState } from 'react';

import { dayLabel, isVerified, originOf } from './shared';
import { verifyTargetAction } from '../../../app/(console)/audits/actions';
import { Icon, InlineMessage } from '../design';
import { PendingButton } from '../design-client';

import type { Asset } from '../../../lib/schemas';

/** "Confirmed by Jatin Singh: owns https://x.example or has written permission to test it." (sent as the statement). */
const attestationStatement = (name: string, origin: string): string =>
  `Confirmed by ${name}: owns ${origin} or has written permission to test it.`;

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

export function VerifyOwnership({
  asset,
  origin: knownOrigin = null,
  viewerName,
  attested,
  onAttested,
  onVerified,
  confirmButton = false,
}: {
  /** Null while the site is being registered: the tick's wording never waits for the API. */
  readonly asset: Asset | null;
  /** The site's origin, known before it is registered (the order). */
  readonly origin?: string | null;
  readonly viewerName: string;
  readonly attested: boolean;
  readonly onAttested: (on: boolean) => void;
  readonly onVerified: (asset: Asset) => void;
  /** Targets: a Confirm button under the tick (the order's Continue does it there). */
  readonly confirmButton?: boolean;
}) {
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
          <b className="font-semibold">You are authorised to test this site.</b>{' '}
          <span className="text-muted-foreground">
            Confirmed
            {asset.ownership.verifiedBy === null ? '' : ` by ${asset.ownership.verifiedBy}`}
            {asset.ownership.verifiedAt === null ? '' : `, ${dayLabel(asset.ownership.verifiedAt)}`}
            .
          </span>
        </span>
      </div>
    );

  const origin = asset === null ? (knownOrigin ?? '') : originOf(asset);

  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-card p-4">
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[10px] border border-border bg-surface-2 px-3.5 py-3 text-[13.5px] text-foreground has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-focus">
        <input
          type="checkbox"
          checked={attested}
          onChange={(e) => {
            onAttested(e.target.checked);
            setAttestError(null);
          }}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={`mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border-[1.5px] ${attested ? 'border-gold-ink bg-gold-ink text-bg' : 'border-input-strong bg-card'}`}
        >
          {attested ? <Icon name="check" size={12} /> : null}
        </span>
        <span className="min-w-0 break-words">
          Yes, I am authorised to run this assessment on <b className="font-semibold">{origin}</b>
        </span>
      </label>
      <span className="text-[12px] leading-[18px] text-muted-foreground">
        By ticking, you confirm you own this site or have permission to test it (for example under a published security or disclosure programme), and you accept responsibility for this assessment. Asked once per site. Recorded as &ldquo;{attestationStatement(viewerName, origin)}&rdquo;
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
    </div>
  );
}
