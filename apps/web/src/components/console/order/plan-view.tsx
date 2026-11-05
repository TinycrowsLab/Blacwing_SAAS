'use client';

// The plan read-back and Gate 1 (experience spec §3.4): one paragraph from a template (lib/plan-text), every value
// underlined and editable in place while the plan is pending; the limits as facts; what happens next; your approval.
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Gate1Card, type Person } from './gate1-card';
import {
  type AccountRow,
  AccountsEditor,
  CareEditor,
  checkAccounts,
  LimitsEditor,
  type LimitValues,
  ObjectiveEditor,
  PathsEditor,
  ReleaseEditor,
} from './plan-editors';
import { type AccountValue, recallAccounts, rememberAccounts } from './secrets';
import { type Care, originOf, refreshSidebar } from './shared';
import { replacePlanAction } from '../../../app/(console)/audits/actions';
import { buttonClass, Icon, InlineMessage, LinkButton, type Voice, VoiceTag } from '../design';
import { PendingButton } from '../design-client';
import { type PlanField, planSegments, usd } from '../../../lib/plan-text';

import type { Asset, AssessmentRequest, Workspace } from '../../../lib/schemas';

const SECONDS_PER_MINUTE = 60;

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

function Fact({ label, value, unit }: { readonly label: string; readonly value: string; readonly unit: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] border border-border bg-card px-4 py-3.5">
      <span className="text-[12.5px] text-muted-foreground">{label}</span>
      <span className="text-[13px] text-muted-foreground">
        <b className="text-[19px] font-semibold tabular-nums text-foreground">{value}</b> {unit}
      </span>
    </div>
  );
}

export function PlanView({
  request,
  asset,
  settings,
  viewer,
}: {
  readonly request: AssessmentRequest;
  readonly asset: Asset | null;
  /** Null when the workspace settings did not load: limits then cannot be edited. */
  readonly settings: Workspace['settings'] | null;
  readonly viewer: Person;
}) {
  const router = useRouter();
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
  const panel = useRef<HTMLDivElement>(null);

  const open = (f: PlanField): void => {
    if (!canEdit) return;
    setEdit(values);
    setRows(startRows());
    setLimitsOk(true);
    setError(null);
    setField(f);
  };
  useEffect(() => {
    if (field !== null) panel.current?.focus();
  }, [field]);

  const save = async (): Promise<boolean> => {
    setError(null);
    let accounts: readonly AccountValue[];
    if (field === 'accounts' || missingValues) {
      const checked = checkAccounts(rows);
      if ('error' in checked) {
        if (field !== 'accounts') {
          setError("Paste the test account values again first: they're never sent back to the browser.");
          setField('accounts');
        } else setError(checked.error);
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
      excludedPaths: [...edit.paths],
      releaseProven: edit.release,
      testAccounts: [...accounts],
    });
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    rememberAccounts(r.data.id, accounts);
    refreshSidebar();
    router.replace(`/audits/${r.data.id}`);
    return true;
  };

  const segments = planSegments({
    host,
    objective: values.objective,
    intrusiveness: values.care,
    excludedPaths: values.paths,
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
            locked={asset?.excludedPaths ?? []}
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

  const heading = pending
    ? 'Here is what we will do.'
    : request.status === 'approved'
      ? 'This is the plan you approved.'
      : 'This plan was not approved.';

  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-8 lg:grid-cols-[minmax(0,640px)_360px] lg:justify-between">
      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex items-center gap-3">
          <span className="text-[12.5px] text-muted-foreground">{pending ? 'New audit' : `Audits / ${host}`}</span>
          <span className="flex-1" />
          {pending ? (
            <>
              <span aria-hidden="true" className="flex gap-1">
                {[1, 2, 3, 4].map((i) => (
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
          <h1 className="m-0 text-[28px] font-semibold leading-[36px] tracking-[-0.01em] text-foreground sm:text-[30px] sm:leading-[38px]">
            {heading}
          </h1>
        </div>

        <p className="m-0 text-[17px] leading-[30px] text-foreground sm:text-[18px] sm:leading-[31px]">
          {segments.map((s, i) =>
            s.field === undefined ? (
              <span key={i}>{s.text}</span>
            ) : canEdit ? (
              <button
                key={i}
                type="button"
                aria-expanded={field === s.field}
                aria-label={`${s.text}. Change ${FIELD_LABEL[s.field].toLowerCase()}`}
                onClick={() => {
                  open(s.field ?? 'objective');
                }}
                className={`inline rounded-[4px] text-left font-semibold underline decoration-gold-ink decoration-dotted decoration-[1.5px] underline-offset-[6px] hover:bg-gold-soft focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus ${field === s.field ? 'bg-gold-soft' : ''} ${s.field === 'paths' && values.paths.length > 0 ? 'font-mono text-[15px]' : ''}`}
              >
                {s.text}
              </button>
            ) : (
              <b key={i} className="font-semibold">
                {s.text}
              </b>
            ),
          )}
        </p>

        {field === null ? (
          <p className="m-0 flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Icon name="info" size={14} />
            {canEdit
              ? 'Click any underlined part to change it. Nothing has been sent to the site yet.'
              : pending
                ? 'Nothing has been sent to the site yet.'
                : 'The plan is pinned to the run: scope, limits and authorisation cannot change under it.'}
          </p>
        ) : (
          <div
            ref={panel}
            tabIndex={-1}
            role="group"
            aria-label={`Change ${FIELD_LABEL[field].toLowerCase()}`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setField(null);
              }
            }}
            className="flex flex-col gap-4 rounded-[16px] border border-gold-line bg-card p-4 shadow-[0_8px_28px_rgba(31,23,4,.06)] focus:outline-none sm:p-5"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="m-0 text-[15px] font-semibold text-foreground">{FIELD_LABEL[field]}</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => {
                  setField(null);
                }}
                className={buttonClass('ghost', 'size-9 px-0')}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
            {editor(field)}
            {error === null ? null : <InlineMessage tone="bad">{error}</InlineMessage>}
            {field === 'host' ? null : (
              <div className="flex flex-wrap items-center gap-2.5">
                <PendingButton
                  variant="secondary"
                  onAction={save}
                  stayPending
                  disabled={!limitsOk}
                  pendingLabel="Updating the plan…"
                  className="border-gold-ink"
                >
                  <Icon name="check" size={15} />
                  Update the plan
                </PendingButton>
                <button
                  type="button"
                  onClick={() => {
                    setField(null);
                  }}
                  className={buttonClass('ghost')}
                >
                  Cancel
                </button>
                <span className="text-[12px] text-muted-foreground">Esc to close</span>
              </div>
            )}
          </div>
        )}

        <div className="grid gap-2.5 sm:grid-cols-3">
          <Fact label="Longest it can run" value={`${values.limits.minutes}`} unit="min" />
          <Fact label="Most requests" value={values.limits.requests.toLocaleString()} unit="to one site" />
          <Fact label="Most it can cost" value={usd(values.limits.costUsd)} unit="model spend" />
        </div>

        <section aria-labelledby="next-h" className="border-t border-border pt-5">
          <h2 id="next-h" className="m-0 mb-4 text-[13px] font-medium text-muted-foreground">
            What happens next
          </h2>
          <ol className="m-0 grid list-none gap-4 p-0 sm:grid-cols-4 sm:gap-3">
            {NEXT_STEPS(values.release === 'auto').map((s, i) => (
              <li key={s.title} className="relative flex gap-3 sm:flex-col sm:gap-2">
                <span className="flex items-center sm:w-full">
                  <span
                    aria-hidden="true"
                    className={`size-3 shrink-0 rounded-full border-2 ${i === 0 && pending ? 'border-gold-ink bg-gold' : 'border-border-strong bg-card'}`}
                  />
                  <span aria-hidden="true" className="hidden h-px flex-1 bg-border-strong sm:block" />
                </span>
                <span className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-semibold text-foreground">
                    {s.title} <VoiceTag voice={s.voice} />
                  </span>
                  <span className="text-[12.5px] leading-[18px] text-muted-foreground">{s.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <div className="lg:pt-[52px]">
        <div className="lg:sticky lg:top-7">
          <Gate1Card
            request={request}
            viewer={viewer}
            selfApprove={settings?.selfApprove ?? request.viewerIsAdmin}
            onBusy={setBusy}
          />
        </div>
      </div>
    </div>
  );
}
