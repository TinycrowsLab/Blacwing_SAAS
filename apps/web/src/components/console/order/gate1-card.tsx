'use client';

// "Your approval" (experience spec §3.4, §6.1): who authorises this audit. Self-approval for an administrator, a link
// for an approver otherwise, Deny and Approve for a reviewer; once decided, a receipt from the ledger.
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { LocalTime } from './local-time';
import { refreshSidebar, wasApproved } from './shared';
import { approveAndStartAction, denyPlanAction, startAuditAction } from '../../../app/(console)/audits/actions';
import { reasonEnough, REASON_MIN } from '../../../lib/normalize';
import { buttonClass, Icon, InlineMessage, LinkButton, Receipt } from '../design';
import { PendingButton, ReasonField } from '../design-client';

import type { AssessmentRequest } from '../../../lib/schemas';

const SUGGESTIONS = ['Staging, refreshed nightly', 'Our own test lab', 'Pre-release check'] as const;
const WAITING_REFRESH_MS = 10_000;
const COPIED_MS = 1800;
const REPLACED = 'Replaced by an edited plan';

export interface Person {
  readonly name: string;
  readonly image: string | null;
}

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');

function Avatar({ person }: { readonly person: Person }) {
  return person.image === null ? (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-text text-[11px] font-semibold text-bg"
    >
      {initialsOf(person.name)}
    </span>
  ) : (
    <img src={person.image} alt="" width={32} height={32} referrerPolicy="no-referrer" className="size-8 shrink-0 rounded-full" />
  );
}

export const when = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(undefined, today ? { hour: '2-digit', minute: '2-digit' } : { dateStyle: 'medium', timeStyle: 'short' }).format(d);
};

function useCopyLink(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      window.clearTimeout(t);
    };
  }, [copied]);
  return [
    copied,
    () => {
      void navigator.clipboard
        .writeText(window.location.href)
        .then(() => {
          setCopied(true);
        })
        .catch(() => {
          window.prompt('Copy this link', window.location.href);
        });
    },
  ];
}

function Shell({ children }: { readonly children: ReactNode }) {
  return (
    <section
      aria-labelledby="gate1-title"
      className="overflow-hidden rounded-[16px] border border-gold-line bg-card shadow-[0_8px_28px_rgba(31,23,4,.06)]"
    >
      <header className="border-b border-gold-line bg-gold-soft px-5 py-4">
        <p className="m-0 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-gold-ink">Your approval</p>
        <h2 id="gate1-title" className="m-0 mt-1 text-[16px] font-semibold text-foreground">
          Who authorises this audit?
        </h2>
      </header>
      <div className="flex flex-col gap-4 p-5">{children}</div>
    </section>
  );
}

const FOOTER = 'Approving records your name and reason, then starts the audit. You can pause or stop it at any time.';

export function Gate1Card({
  request,
  viewer,
  selfApprove,
  onBusy,
  unsaved = null,
}: {
  readonly request: AssessmentRequest;
  readonly viewer: Person;
  /** From the workspace settings: an administrator may approve their own plan. */
  readonly selfApprove: boolean;
  /** Edits are locked while a decision is in flight. */
  readonly onBusy: (busy: boolean) => void;
  /** The plan editor that is open with a change not yet applied (its name), or null. */
  readonly unsaved?: string | null;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  // The reason survives a reload of this tab. Read after mount, so the server and the first client render agree.
  const reasonKey = `bw:gate1-reason:${request.id}`;
  useEffect(() => {
    try {
      const kept = window.sessionStorage.getItem(reasonKey);
      if (kept !== null) setReason(kept);
    } catch {
      // Storage blocked: the field simply starts empty.
    }
  }, [reasonKey]);
  const keepReason = (v: string): void => {
    setReason(v);
    try {
      window.sessionStorage.setItem(reasonKey, v);
    } catch {
      // Storage blocked: nothing to keep.
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [needReason, setNeedReason] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting'>('idle');
  const [copied, copyLink] = useCopyLink();
  const [askedApprover, setAskedApprover] = useState(false);
  const field = useRef<HTMLDivElement>(null);
  const pending = request.status === 'pending_gate1';
  const isRequester = request.viewerIsRequester;
  const mayApprove = !isRequester || selfApprove;

  // Waiting for someone else: show their decision when it lands.
  useEffect(() => {
    if (!pending || mayApprove) return;
    const t = window.setInterval(() => {
      router.refresh();
    }, WAITING_REFRESH_MS);
    return () => {
      window.clearInterval(t);
    };
  }, [pending, mayApprove, router]);

  const requireReason = (): boolean => {
    if (reasonEnough(reason)) return true;
    setNeedReason(true);
    field.current?.querySelector('textarea')?.focus();
    return false;
  };

  // A long plan page is scrolled down on a phone: start the run page from the top, so the swap never shows a blank
  // stretch below a shorter page.
  const toRun = (runId: string): void => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    router.push(`/runs/${runId}`);
  };

  const approve = async (): Promise<boolean> => {
    setError(null);
    if (unsaved !== null) {
      setError(`You changed ${unsaved.toLowerCase()} but haven't applied it. Press Update the plan, or Cancel, then approve.`);
      return false;
    }
    if (!requireReason()) return false;
    onBusy(true);
    const r = await approveAndStartAction(request.id, reason);
    if (!r.ok) {
      onBusy(false);
      setError(`Not approved: ${r.message}`);
      return false;
    }
    setPhase('starting');
    refreshSidebar();
    toRun(r.data.runId);
    return true;
  };

  const deny = async (): Promise<boolean> => {
    setError(null);
    if (!requireReason()) return false;
    onBusy(true);
    const r = await denyPlanAction(request.id, reason);
    onBusy(false);
    if (!r.ok) {
      setError(`Couldn't record your decision: ${r.message}`);
      return false;
    }
    refreshSidebar();
    router.refresh();
    return true;
  };

  if (!pending) {
    const approved = wasApproved(request.status);
    const by = request.approver?.name ?? 'someone';
    const at =
      request.decidedAt === null ? null : (
        <>
          , <LocalTime iso={request.decidedAt} format={when} />
        </>
      );
    const replaced = request.decisionReason === REPLACED;
    return (
      <Shell>
        <Receipt
          tone={approved ? 'ok' : replaced ? 'muted' : 'bad'}
          title={
            <>
              {approved ? `Approved by ${by}` : replaced ? 'Replaced by an edited plan' : `Not approved by ${by}`}
              {at}
            </>
          }
          detail={request.decisionReason === null || replaced ? undefined : `“${request.decisionReason}”`}
          hash={request.audit?.hash ?? null}
        />
        {approved && request.runId !== null ? (
          <LinkButton href={`/runs/${request.runId}`} variant="primary" className="h-12 rounded-xl text-[14.5px]">
            {request.status === 'running' ? <>Watch Claude&apos;s team work</> : 'Open the audit'}
            <Icon name="arrow" size={16} />
          </LinkButton>
        ) : approved ? (
          <PendingButton
            onAction={async () => {
              const r = await startAuditAction(request.id);
              if (!r.ok) {
                setError(r.message);
                return false;
              }
              refreshSidebar();
              toRun(r.data.runId);
              return true;
            }}
            stayPending
            pendingLabel="Starting…"
            className="h-12 rounded-xl text-[14.5px]"
          >
            Start the audit
            <Icon name="arrow" size={16} />
          </PendingButton>
        ) : (
          <LinkButton href="/audits/new" variant={replaced ? 'secondary' : 'primary'} className="h-11 rounded-xl">
            Start a new audit
          </LinkButton>
        )}
        {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
      </Shell>
    );
  }

  if (!mayApprove)
    return (
      <Shell>
        <p className="m-0 text-[13.5px] leading-[21px] text-foreground">
          <b className="font-semibold">A second person must approve this.</b>{' '}
          <span className="text-muted-foreground">Send them this page; they read the same plan and decide.</span>
        </p>
        <button
          type="button"
          onClick={() => {
            copyLink();
            setAskedApprover(true);
          }}
          className={buttonClass('primary', 'h-12 w-full rounded-xl text-[14.5px]')}
        >
          <Icon name={copied ? 'check' : 'copy'} size={16} />
          <span aria-live="polite">{copied ? 'Link copied' : 'Copy link for an approver'}</span>
        </button>
        {askedApprover ? (
          <InlineMessage tone="gold">Waiting for approval. We&apos;ll show it here when someone decides.</InlineMessage>
        ) : null}
        <p className="m-0 border-t border-dashed border-border-strong pt-3 text-[12px] leading-[18px] text-muted-foreground">
          The approver&apos;s name and reason are recorded in the ledger.
        </p>
      </Shell>
    );

  const reviewer = !isRequester;
  return (
    <Shell>
      <div className="flex items-start gap-3">
        <Avatar person={viewer} />
        <p className="m-0 text-[13.5px] leading-[21px] text-foreground">
          {reviewer ? (
            <>
              <b className="font-semibold">{request.requester.name ?? 'A colleague'} asks you to approve this.</b>{' '}
              <span className="text-muted-foreground">Read the plan, then decide. Your reason goes on the ledger.</span>
            </>
          ) : (
            <>
              <b className="font-semibold">You can approve it yourself.</b>{' '}
              <span className="text-muted-foreground">You own this workspace and the site is verified as yours.</span>
            </>
          )}
        </p>
      </div>
      <div ref={field}>
        <ReasonField
          label={
            <span className="flex items-center justify-between">
              {reviewer ? 'Your reason' : 'Why is it safe to run?'}
              <span className="text-[12px] font-normal text-muted-foreground">required</span>
            </span>
          }
          value={reason}
          onChange={(v) => {
            keepReason(v);
            setNeedReason(false);
            setError(null);
          }}
          onSubmit={() => {
            document.querySelector<HTMLButtonElement>('[data-approve] button')?.click();
          }}
          suggestions={reviewer ? [] : SUGGESTIONS}
          placeholder={reviewer ? 'What you checked, in a few words' : 'For example: our staging copy, refreshed nightly'}
          rows={2}
        />
      </div>
      {needReason ? (
        <InlineMessage tone="bad">Add a few words, at least {REASON_MIN} characters. It&apos;s kept with your name.</InlineMessage>
      ) : null}
      {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
      <div className={reviewer ? 'grid grid-cols-2 gap-2.5' : 'flex flex-col'}>
        {reviewer ? (
          <PendingButton variant="deny" onAction={deny} pendingLabel="Denying…" className="h-12 rounded-xl text-[14.5px]">
            Deny
          </PendingButton>
        ) : null}
        <span data-approve className="contents [&_button]:w-full">
          <PendingButton
            onAction={approve}
            stayPending
            disabled={!reasonEnough(reason)}
            {...(reasonEnough(reason) ? {} : { describedBy: 'gate1-need' })}
            pendingLabel={phase === 'starting' ? 'Starting…' : 'Approving…'}
            className="h-12 rounded-xl text-[14.5px]"
          >
            Approve and start
            <Icon name="arrow" size={16} />
          </PendingButton>
        </span>
      </div>
      {reasonEnough(reason) ? null : (
        <p id="gate1-need" className="m-0 -mt-1.5 text-center text-[12px] text-muted-foreground">
          {reviewer ? 'Write your reason above to decide.' : 'Write a reason above, or pick one, to approve.'}
        </p>
      )}
      {reviewer ? null : (
        <p className="m-0 text-center text-[13px] text-muted-foreground">
          or{' '}
          <button
            type="button"
            onClick={copyLink}
            className="rounded font-medium text-gold-ink hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
          >
            <span aria-live="polite">{copied ? 'link copied for a colleague' : 'ask a colleague to approve'}</span>
          </button>
        </p>
      )}
      <p className="m-0 flex items-start gap-2 border-t border-dashed border-border-strong pt-3 text-[12px] leading-[18px] text-muted-foreground">
        <Icon name="ledger" size={14} className="mt-0.5 shrink-0" />
        {FOOTER}
      </p>
    </Shell>
  );
}
