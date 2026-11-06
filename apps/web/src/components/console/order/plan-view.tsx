'use client';

// The plan read-back and Gate 1 (experience spec §3.4): one paragraph from a template (lib/plan-text), every value
// underlined and editable in place while the plan is pending; the limits as facts; what happens next; your approval.
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { DISCARDED, Gate1Card, type Person } from './gate1-card';
import {
  type AccountRow,
  AccountsEditor,
  CareEditor,
  checkAccounts,
  leftOutText,
  LimitsEditor,
  type LimitValues,
  ObjectiveEditor,
  PathsEditor,
  readPathList,
  ReleaseEditor,
} from './plan-editors';
import { type AccountValue, recallAccounts, rememberAccounts } from './secrets';
import { type Care, originOf, refreshSidebar, wasApproved } from './shared';
import { replacePlanAction } from '../../../app/(console)/audits/actions';
import { type PlanField, planSegments, usd } from '../../../lib/plan-text';
import { buttonClass, Icon, InlineMessage, LinkButton, type Voice, VoiceTag } from '../design';
import { PendingButton } from '../design-client';

import type { Asset, AssessmentRequest, Workspace } from '../../../lib/schemas';

const SECONDS_PER_MINUTE = 60;
const REPLACED = 'Replaced by an edited plan';
const NEXT_STEP_COUNT = 4;
/** The order's four questions, all answered by now. */
const ANSWERED = [1, 2, 3, 4] as const; // eslint-disable-line @typescript-eslint/no-magic-numbers -- the question numbers

const FIELD_LABEL: Record<PlanField, string> = {
  host: 'The site',
  objective: 'What Claude looks for',
  intrusiveness: 'How careful Claude is',
  paths: 'Paths to avoid',
  accounts: 'Signed-in testing',
  limits: 'Limits',
  release: 'Proven issues',
};

interface Values {
  readonly objective: string;
  readonly care: Care;
  readonly paths: readonly string[];
  readonly limits: LimitValues;
  readonly release: 'hold' | 'auto';
}

function valuesOf(r: AssessmentRequest): Values {
  return {
    objective: r.objective,
    care: r.intrusiveness === 'passive' ? 'passive' : 'active_safe',
    paths: r.excludedPaths,
    limits: {
      minutes: Math.round(r.budget.seconds / SECONDS_PER_MINUTE),
      requests: r.budget.requests,
      costUsd: r.budget.costUsd ?? 0,
    },
    release: r.releaseProven,
  };
}

const NEXT_STEPS = (auto: boolean): readonly { title: string; voice: Voice; body: string }[] =>
  [
    { title: 'You approve', voice: 'you', body: 'Your reason goes on the ledger.' },
    { title: 'Claude maps the site', voice: 'claude', body: 'Recon, then the planner writes test cases you can read.' },
    { title: 'Testing, live', voice: 'claude', body: 'You watch the agents talk. Risky requests wait for you.' },
    auto
      ? { title: 'Proof, then release', voice: 'blackwing', body: 'Each issue is replayed with a control. Proven ones are released, as you chose.' }
      : { title: 'Proof, then you release', voice: 'you', body: 'Each issue is replayed with a control. You choose what ships.' },
  ];

/** "/admin, /billing and /ftp": the paths in mono, the words between them in the sentence's own type. */
function PathsText({ text }: { readonly text: string }) {
  return (
    <>
      {text.split(/(\/[^\s,]*)/).map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-[15px]">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** One limit: a row (label left, value right) on a phone, a tile from sm up. */
function Fact({ label, value, unit }: { readonly label: string; readonly value: string; readonly unit: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 rounded-[14px] border border-border bg-card px-4 py-3 sm:flex-col sm:items-start sm:justify-start sm:gap-1 sm:py-3.5">
      <span className="text-[12.5px] leading-4 text-muted-foreground">{label}</span>
      <span className="whitespace-nowrap text-[13px] text-muted-foreground">
        <b className="text-[17px] font-semibold tabular-nums text-foreground sm:text-[19px]">{value}</b> {unit}
      </span>
    </div>
  );
}

const isField = (v: string | null): v is PlanField => v !== null && v in FIELD_LABEL;
const list = (items: readonly string[]): string =>
  new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' }).format(items);

export function PlanView({
  request,
  asset,
  settings,
  viewer,
  replacedBy = null,
}: {
  readonly request: AssessmentRequest;
  /** The plan that replaced this one (an edit), when it was found. */
  readonly replacedBy?: string | null;
  readonly asset: Asset | null;
  /** Null when the workspace settings did not load: limits then cannot be edited. */
  readonly settings: Workspace['settings'] | null;
  readonly viewer: Person;
}) {
  const router = useRouter();
  const updatedParam = useSearchParams().get('updated');
  const values = valuesOf(request);
  const origin = asset === null ? null : originOf(asset);
  const host = origin === null ? (request.assetName ?? 'the site') : new URL(origin).host;
  const pending = request.status === 'pending_gate1';
  const [busy, setBusy] = useState(false);
  const canEdit = pending && request.viewerIsRequester && !busy;

  const [field, setField] = useState<PlanField | null>(null);
  const [edit, setEdit] = useState<Values>(values);
  const [limitsOk, setLimitsOk] = useState(true);
  const known = recallAccounts(request.id);
  const missingValues = request.testAccounts.length > 0 && known === undefined;
  const startRows = (): AccountRow[] =>
    known?.map((a) => ({ ...a })) ??
    request.testAccounts.map((a) => ({ role: a.role, headerName: a.headerName, headerValue: '' }));
  const [rows, setRows] = useState<readonly AccountRow[]>(startRows);
  const [error, setError] = useState<string | null>(null);
  /** Paths typed but not yet a chip: Update includes them, so a click never depends on the field's blur. */
  const [pathText, setPathText] = useState('');
  /** The value just changed by Update the plan (from ?updated=), highlighted until the next edit. */
  const [updated, setUpdated] = useState<PlanField | null>(isField(updatedParam) ? updatedParam : null);
  const panel = useRef<HTMLDivElement>(null);
  const h1 = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** The approval card; on a phone it sits below the plan, so a bar leads to it until it is on screen. */
  const approval = useRef<HTMLDivElement>(null);
  const [approvalSeen, setApprovalSeen] = useState(true);
  useEffect(() => {
    // The approve button itself, not the card's header: the bar stays until the person can press it.
    const el = approval.current?.querySelector('[data-approve] button') ?? approval.current;
    if (el === null || !pending) return;
    const io = new IntersectionObserver(([e]) => {
      setApprovalSeen(e?.isIntersecting ?? true);
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [pending]);

  // Focus lands on the heading (spec §10.4); "?updated=" is shown once, then dropped so a reload does not repeat it.
  useEffect(() => {
    h1.current?.focus();
    if (updatedParam !== null) window.history.replaceState(window.history.state, '', window.location.pathname);
  }, [updatedParam]);

  const open = (f: PlanField): void => {
    if (!canEdit) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEdit(values);
    setRows(startRows());
    setLimitsOk(true);
    setError(null);
    setPathText('');
    setUpdated(null);
    setField(f);
  };
  const close = (): void => {
    setField(null);
    setError(null);
    opener.current?.focus();
  };
  // The editor's own field gets focus (the chip field, or the picked option), so typing goes where it belongs.
  useEffect(() => {
    const p = panel.current;
    if (field === null || p === null) return;
    const first =
      p.querySelector<HTMLElement>(field === 'paths' ? 'input' : 'input:checked') ??
      p.querySelector<HTMLElement>('input, textarea, a[href]');
    (first ?? p).focus();
  }, [field]);

  const save = async (): Promise<boolean> => {
    setError(null);
    let paths = edit.paths;
    if (field === 'paths' && pathText.trim() !== '') {
      const typed = readPathList(pathText, origin, edit.paths);
      if (typed.left.length > 0) {
        setError(leftOutText(typed.left));
        return false;
      }
      paths = typed.paths;
    }
    let accounts: readonly AccountValue[];
    if (field === 'accounts' || missingValues) {
      const checked = checkAccounts(rows);
      if ('error' in checked) {
        // The values are asked for right here (below the editor), so the person stays on what they were changing.
        setError(field === 'accounts' ? checked.error : `To keep your test accounts: ${checked.error.charAt(0).toLowerCase()}${checked.error.slice(1)}`);
        return false;
      }
      accounts = checked.accounts;
    } else accounts = known ?? [];
    if (asset === null) return false;
    const r = await replacePlanAction(request.id, {
      assetId: request.assetId,
      objective: edit.objective,
      intrusiveness: edit.care,
      minutes: edit.limits.minutes,
      requests: edit.limits.requests,
      costUsd: edit.limits.costUsd,
      excludedPaths: [...paths],
      releaseProven: edit.release,
      testAccounts: [...accounts],
    });
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    rememberAccounts(r.data.id, accounts);
    refreshSidebar();
    router.replace(`/audits/${r.data.id}?updated=${field ?? 'objective'}`);
    return true;
  };

  const rowsChanged =
    JSON.stringify(rows.map((r) => [r.role, r.headerName, r.headerValue])) !==
    JSON.stringify(startRows().map((r) => [r.role, r.headerName, r.headerValue]));
  /** An editor with a change not yet applied: Approve waits for Update or Cancel. */
  const unsaved =
    field !== null &&
    field !== 'host' &&
    (JSON.stringify(edit) !== JSON.stringify(values) || rowsChanged || pathText.trim() !== '' || !limitsOk)
      ? FIELD_LABEL[field]
      : null;
  const locked = asset?.excludedPaths ?? [];
  const allPaths = [...new Set([...locked, ...values.paths])];

  const segments = planSegments({
    host,
    objective: values.objective,
    intrusiveness: values.care,
    excludedPaths: allPaths,
    roles: request.testAccounts.map((a) => a.role),
    minutes: values.limits.minutes,
    requests: values.limits.requests,
    costUsd: values.limits.costUsd,
    releaseProven: values.release,
  });

  const editor = (f: PlanField) => {
    switch (f) {
      case 'host':
        return (
          <div className="flex flex-col items-start gap-3">
            <p className="m-0 text-[13.5px] text-muted-foreground">
              This audit is for <b className="font-medium text-foreground">{origin ?? host}</b>. To audit a different site,
              start a new audit.
            </p>
            <LinkButton href="/audits/new" variant="secondary">
              Start a new audit
            </LinkButton>
          </div>
        );
      case 'objective':
        return (
          <ObjectiveEditor
            value={edit.objective}
            onChange={(objective) => {
              setEdit({ ...edit, objective });
            }}
          />
        );
      case 'intrusiveness':
        return (
          <CareEditor
            value={edit.care}
            onChange={(care) => {
              setEdit({ ...edit, care });
            }}
          />
        );
      case 'paths':
        return (
          <PathsEditor
            value={edit.paths}
            onChange={(paths) => {
              setEdit({ ...edit, paths });
            }}
            origin={origin}
            locked={locked}
            onText={setPathText}
          />
        );
      case 'accounts':
        return <AccountsEditor rows={rows} onRows={setRows} missingValues={missingValues} />;
      case 'limits':
        return settings === null ? (
          <InlineMessage tone="bad">We couldn&apos;t load your workspace limits. Reload the page and try again.</InlineMessage>
        ) : (
          <LimitsEditor
            value={edit.limits}
            settings={settings}
            onChange={(limits) => {
              setLimitsOk(limits !== null);
              if (limits !== null) setEdit({ ...edit, limits });
            }}
          />
        );
      case 'release':
        return (
          <ReleaseEditor
            value={edit.release}
            onChange={(release) => {
              setEdit({ ...edit, release });
            }}
          />
        );
    }
  };

  const approved = wasApproved(request.status);
  const approver = request.approver?.name ?? null;
  const heading = pending
    ? 'Here is what we will do.'
    : approved
      ? approver === null || approver === viewer.name
        ? 'This is the plan you approved.'
        : `This is the plan ${approver} approved.`
      : request.decisionReason === REPLACED
        ? 'This plan was replaced by an edited one.'
        : request.decisionReason === DISCARDED
          ? 'This plan was discarded.'
          : 'This plan was not approved.';
  /** The timeline's progress: the current stop (gold) and those already done (ticked). */
  const reached = pending ? 0 : approved ? (request.status === 'completed' ? NEXT_STEP_COUNT : 1) : -1;

  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,640px)_380px] lg:justify-center">
      <div className="flex min-w-0 flex-col gap-5 lg:col-start-1">
        <div className="flex items-center gap-3">
          <span className="text-[12.5px] text-muted-foreground">{pending ? 'New audit' : `Audits / ${host}`}</span>
          <span className="flex-1" />
          {pending ? (
            <>
              <span aria-hidden="true" className="flex gap-1">
                {ANSWERED.map((i) => (
                  <span key={i} className="h-[3px] w-6 rounded-full bg-gold-ink sm:w-10" />
                ))}
              </span>
              <span className="text-[12.5px] text-muted-foreground">All 4 answered</span>
            </>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <p className="m-0 flex items-center gap-1.5 text-[13px] font-medium text-gold-ink">
            <Icon name="file" size={14} />
            The plan
          </p>
          <h1
            ref={h1}
            tabIndex={-1}
            className="m-0 text-[28px] font-semibold leading-[36px] tracking-[-0.01em] text-foreground focus:outline-none sm:text-[30px] sm:leading-[38px]"
          >
            {heading}
          </h1>
        </div>

        <p className="m-0 text-[17px] leading-[30px] text-foreground sm:text-[18px] sm:leading-[31px]">
          {segments.map((s, i) =>
            s.field === undefined ? (
              <span key={i}>{s.text}</span>
            ) : canEdit ? (
              // A span, not a <button>: buttons cannot wrap across lines, and this value reads as part of the sentence.
              <span
                key={i}
                role="button"
                tabIndex={0}
                aria-expanded={field === s.field}
                aria-label={`${s.text}. Change ${FIELD_LABEL[s.field].toLowerCase()}`}
                onClick={() => {
                  open(s.field ?? 'objective');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open(s.field ?? 'objective');
                  }
                }}
                className={`box-decoration-clone cursor-pointer rounded-[4px] font-medium underline decoration-gold decoration-dotted decoration-[1.5px] underline-offset-[6px] transition-colors hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${field === s.field || updated === s.field ? 'bg-gold-soft' : ''}`}
              >
                {s.field === 'paths' && allPaths.length > 0 ? <PathsText text={s.text} /> : s.text}
              </span>
            ) : (
              <b key={i} className="font-medium">
                {s.text}
              </b>
            ),
          )}
        </p>

        {field === null && updated !== null ? (
          <p role="status" className="m-0 flex items-center gap-2 text-[12.5px] font-medium text-ok">
            <Icon name="check" size={14} />
            Plan updated: {FIELD_LABEL[updated].toLowerCase()} changed. Nothing has been sent to the site yet.
          </p>
        ) : field === null ? (
          <p className="m-0 flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Icon name="info" size={14} />
            {canEdit ? (
              // Neutral on purpose: a phone with a mouse, or a laptop with a touch screen, reads it right either way.
              'Change any underlined part. Nothing has been sent to the site yet.'
            )
              : pending
                ? 'Nothing has been sent to the site yet.'
                : approved
                  ? 'The plan is pinned to the run: scope, limits and authorisation cannot change under it.'
                  : 'Nothing was sent to the site.'}
          </p>
        ) : (
          <div
            ref={panel}
            tabIndex={-1}
            role="group"
            data-no-shortcuts
            aria-label={`Change ${FIELD_LABEL[field].toLowerCase()}`}
            onKeyDown={(e) => {
              // Keys typed here belong to the editor: never the page's single-key shortcuts (N opens a new audit).
              if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              } else if (e.key === 'Enter' && !e.isDefaultPrevented() && e.target instanceof HTMLInputElement) {
                // Enter applies the change (spec §10.4); a chip field with text makes its chip first.
                e.preventDefault();
                panel.current?.querySelector<HTMLButtonElement>('[data-update] button')?.click();
              }
            }}
            className="flex flex-col gap-4 rounded-[16px] border border-gold-line bg-card p-4 shadow-[0_8px_28px_rgba(31,23,4,.06)] focus:outline-none sm:p-5"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="m-0 text-[15px] font-semibold text-foreground">{FIELD_LABEL[field]}</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={close}
                className={buttonClass('ghost', 'size-9 px-0')}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            {editor(field)}
            {missingValues && field !== 'accounts' && field !== 'host' ? (
              // shortcut: an edit re-creates the request and the API never returns account values, so they are asked
              // for here, up front. Upgrade when the API copies them across a replacement (PATCH /requests/:id).
              <div className="flex flex-col gap-2.5 border-t border-dashed border-border-strong pt-3.5">
                <InlineMessage tone="gold">
                  This plan signs in as <b>{list(request.testAccounts.map((a) => a.role))}</b>. Changing the plan needs
                  {request.testAccounts.length === 1 ? ' that account\u2019s value' : ' those accounts\u2019 values'} again:
                  they&apos;re never sent back to the browser.
                </InlineMessage>
                <AccountsEditor rows={rows} onRows={setRows} missingValues valuesOnly />
              </div>
            ) : null}
            {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
            {field === 'host' ? null : (
              // mousedown keeps focus in the field: its blur would turn typed text into a chip, move this row, and
              // the click would land off the button. Update reads the typed text itself instead.
              <div
                className="flex flex-wrap items-center gap-2.5"
                onMouseDown={(e) => {
                  if (e.target instanceof Element && e.target.closest('button') !== null) e.preventDefault();
                }}
              >
                <span data-update className="contents">
                  <PendingButton
                    variant="secondary"
                    onAction={save}
                    stayPending
                    disabled={!limitsOk}
                    pendingLabel="Updating the plan…"
                  >
                    <Icon name="check" size={15} />
                    Update the plan
                  </PendingButton>
                </span>
                <button type="button" onClick={close} className={buttonClass('ghost')}>
                  Cancel
                </button>
                <span className="hidden text-[12px] text-muted-foreground sm:inline">Enter to update · Esc to close</span>
              </div>
            )}
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-3 sm:gap-2.5">
          <Fact label="Longest it can run" value={`${values.limits.minutes}`} unit="min" />
          <Fact label="Most requests" value={values.limits.requests.toLocaleString()} unit="to one site" />
          <Fact label="Most it can cost" value={usd(values.limits.costUsd)} unit="model spend" />
        </div>

      </div>

      <div ref={approval} className="scroll-mt-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:pt-[52px]">
        <div className="lg:sticky lg:top-7">
          <Gate1Card
            request={request}
            viewer={viewer}
            selfApprove={settings?.selfApprove ?? request.viewerIsAdmin}
            onBusy={setBusy}
            unsaved={unsaved}
            replacedBy={replacedBy}
          />
        </div>
      </div>
      <div className={`min-w-0 lg:col-start-1 ${pending ? 'max-lg:pb-20' : ''}`}>
        <section aria-labelledby="next-h" className="border-t border-border pt-5">
          <h2 id="next-h" className="m-0 mb-4 text-[13px] font-medium text-muted-foreground">
            What happens next
          </h2>
          <ol className="m-0 grid list-none gap-4 p-0 sm:grid-cols-4 sm:gap-3">
            {NEXT_STEPS(values.release === 'auto').map((s, i) => (
              <li key={s.title} className="relative flex gap-3 sm:flex-col sm:gap-2">
                <span className="flex items-center sm:w-full">
                  {i < reached ? (
                    <span className="flex size-3 shrink-0 items-center justify-center rounded-full bg-gold-ink text-bg">
                      <Icon name="check" size={8} />
                    </span>
                  ) : (
                    <span
                      aria-hidden="true"
                      className={`size-3 shrink-0 rounded-full border-2 ${i === reached ? 'border-gold-ink bg-gold' : 'border-border-strong bg-card'}`}
                    />
                  )}
                  <span aria-hidden="true" className="hidden h-px flex-1 bg-border-strong sm:block" />
                </span>
                <span className="flex flex-col items-start gap-1">
                  {/* The voice tag sits on its own line above every title, so the four stops line up. */}
                  <VoiceTag voice={s.voice} />
                  <span className="text-[13.5px] font-semibold text-foreground">
                    {s.title}
                    {i < reached ? <span className="sr-only"> (done)</span> : null}
                  </span>
                  <span className="text-[12.5px] leading-[18px] text-muted-foreground">{s.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      {pending && !approvalSeen && field === null ? (
        // Phones: the plan is long and the approval sits below it. One bar leads there (it hides once the card shows,
        // so the card's own button stays the only gold one on screen).
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-bg px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 lg:hidden">
          <button
            type="button"
            onClick={() => {
              approval.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
              const card = approval.current;
              (card?.querySelector('textarea') ?? card?.querySelector('button'))?.focus({ preventScroll: true });
            }}
            className={buttonClass('primary', 'h-12 w-full rounded-xl text-[14.5px]')}
          >
            Go to your approval
            <Icon name="arrow" size={16} className="rotate-90" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
