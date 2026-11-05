/* eslint-disable @typescript-eslint/no-magic-numbers -- design pixel values, see design/README.md */
'use client';

// Two side sheets of the live run: "Run details" (bug 3), what was pinned when the run started (scope, limits,
// authorisation, runner) read from run.pins; and one recorded request with its response (a call row or a Requests tab
// row opens it). Both read only what the API returned; a missing value says so instead of being guessed.
import { z } from 'zod';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@blackwing/ui';

import { Chip } from './design';
import { CopyField } from './design-client';
import { type Exchange, pathOf } from './run-model';
import { agentName } from '../../lib/agents';
import { limitsPhrase } from '../../lib/plan-text';

import type { Run } from '../../lib/schemas';
import type { ReactNode } from 'react';

const SHEET =
  'w-full max-w-[560px] gap-0 overflow-y-auto border-border bg-card p-0 text-foreground sm:max-w-[560px] [&>button]:right-5 [&>button]:top-5';

const pinnedRequestSchema = z
  .object({
    objective: z.string().default(''),
    intrusiveness: z.string().default(''),
    budget: z.object({ requests: z.number(), seconds: z.number(), costUsd: z.number() }).optional(),
    testAccounts: z.array(z.object({ role: z.string(), headerName: z.string() })).default([]),
    releaseProven: z.enum(['hold', 'auto']).optional(),
    decidedAt: z.string().nullable().optional(),
  })
  .loose();
const runnerSchema = z.object({ name: z.string(), version: z.string() }).loose();

export const CARE_LABEL: Readonly<Record<string, string>> = { passive: "Look, don't touch", active_safe: 'Probe gently' };

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 border-b border-border py-2.5 text-[13px] last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="px-6 py-4">
      <h3 className="m-0 mb-1 text-[12px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">{title}</h3>
      <dl className="m-0">{children}</dl>
    </section>
  );
}

const none = <span className="text-muted-foreground">None</span>;
const mono = (text: string): ReactNode => <span className="font-mono text-[12px]">{text}</span>;

export function RunDetailsSheet({
  run,
  model,
  open,
  onOpenChange,
}: {
  readonly run: Run;
  /** The model named by run.started, or null before the run starts. */
  readonly model: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const asset = run.pins.asset;
  const req = pinnedRequestSchema.safeParse(run.pins.request ?? {});
  const request = req.success ? req.data : null;
  const runner = runnerSchema.safeParse(run.pins.runner);
  const auth = run.pins.authorisation;
  const budget = request?.budget ?? run.budget;
  const fmt = (iso: string | null | undefined): string =>
    iso === null || iso === undefined ? 'Not recorded' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={SHEET}>
        <div className="border-b border-border px-6 pb-4 pt-5">
          <SheetTitle className="text-[18px] font-semibold">Run details</SheetTitle>
          <SheetDescription className="mt-1 text-[12.5px] text-muted-foreground">
            Pinned when the run started. The runner enforces these; nothing here changes during the run.
          </SheetDescription>
        </div>
        <Section title="Target and scope">
          <Row label="Target">{asset?.baseUrl ?? asset?.name ?? 'Not recorded'}</Row>
          <Row label="Allowed origins">
            {asset === undefined || asset.allowedOrigins.length === 0 ? none : (
              <span className="flex flex-col gap-0.5">{asset.allowedOrigins.map((o) => <span key={o}>{mono(o)}</span>)}</span>
            )}
          </Row>
          <Row label="Paths to avoid">
            {asset === undefined || asset.excludedPaths.length === 0 ? none : (
              <span className="flex flex-wrap gap-1">
                {asset.excludedPaths.map((p) => (
                  <Chip key={p} tone="muted">
                    <span className="font-mono">{p}</span>
                  </Chip>
                ))}
              </span>
            )}
          </Row>
        </Section>
        <Section title="What you asked for">
          <Row label="Objective">{request === null || request.objective === '' ? 'Not recorded' : request.objective}</Row>
          <Row label="Care level">
            {request === null ? 'Not recorded' : (
              <>
                {CARE_LABEL[request.intrusiveness] ?? request.intrusiveness} {mono(request.intrusiveness)}
              </>
            )}
          </Row>
          <Row label="Signed-in testing">
            {request === null || request.testAccounts.length === 0 ? 'As a visitor, no test accounts' : (
              <span className="flex flex-col gap-0.5">
                {request.testAccounts.map((a) => (
                  <span key={a.role}>
                    {mono(a.role)} <span className="text-muted-foreground">via the {a.headerName} header</span>
                  </span>
                ))}
              </span>
            )}
          </Row>
          <Row label="Limits">
            Stops at the first of {limitsPhrase({ minutes: Math.round(budget.seconds / 60), requests: budget.requests, costUsd: budget.costUsd })}
          </Row>
          <Row label="Proven issues">
            {request?.releaseProven === 'auto'
              ? 'Released automatically'
              : request?.releaseProven === 'hold'
                ? 'Wait for your release'
                : 'Not recorded'}
          </Row>
        </Section>
        <Section title="Authorisation">
          <Row label="Approved by">{auth?.signedBy ?? 'Not recorded'}</Row>
          <Row label="Approved at">{fmt(request?.decidedAt)}</Row>
          <Row label="Authorisation id">{auth === undefined ? 'Not recorded' : mono(auth.saId)}</Row>
          <Row label="Signing key">{auth === undefined ? 'Not recorded' : mono(auth.keyId)}</Row>
        </Section>
        <Section title="Runner">
          <Row label="Runner">{runner.success ? mono(`${runner.data.name} ${runner.data.version}`) : 'Not recorded'}</Row>
          <Row label="Model">{model === null ? 'Not started yet' : mono(model)}</Row>
          <Row label="Queued">{fmt(run.createdAt)}</Row>
          <Row label="Started">{fmt(run.startedAt)}</Row>
        </Section>
        <div className="px-6 pb-6 pt-2">
          <CopyField label="Run id" value={run.id} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Headers({ headers }: { readonly headers: Readonly<Record<string, string>> | null }) {
  const rows = Object.entries(headers ?? {});
  if (rows.length === 0) return <p className="m-0 text-[12px] text-muted-foreground">No headers recorded.</p>;
  return (
    <pre className="m-0 max-h-48 overflow-auto rounded-[10px] border border-border bg-code p-3 font-mono text-[11.5px] leading-[18px]">
      {rows.map(([k, v]) => `${k}: ${v}`).join('\n')}
    </pre>
  );
}

function Body({ text }: { readonly text: string | null }) {
  if (text === null || text === '') return <p className="m-0 text-[12px] text-muted-foreground">No body.</p>;
  return (
    <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-[10px] border border-border bg-code p-3 font-mono text-[11.5px] leading-[18px]">
      {text}
    </pre>
  );
}

const OUTCOME: Readonly<Record<string, string>> = {
  sent: 'Sent',
  blocked: 'Blocked by scope: not sent',
  denied: 'Denied at your decision: not sent',
  error: 'Failed before an answer',
};

export function ExchangeSheet({
  exchange,
  state,
  onOpenChange,
  onRetry,
}: {
  readonly exchange: Exchange | null;
  /** `loading` while the page of exchanges is fetched, `missing` when the id is not (yet) recorded. */
  readonly state: 'closed' | 'loading' | 'ready' | 'missing' | 'error';
  readonly onOpenChange: (open: boolean) => void;
  readonly onRetry: () => void;
}) {
  return (
    <Sheet open={state !== 'closed'} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={SHEET}>
        <div className="border-b border-border px-6 pb-4 pt-5">
          <SheetTitle className="pr-8 text-[16px] font-semibold">
            {exchange === null ? 'Request' : (
              <span className="font-mono text-[14px]">
                <span className="text-slate">{exchange.method}</span> {pathOf(exchange.url)}
              </span>
            )}
          </SheetTitle>
          <SheetDescription className="mt-1 text-[12.5px] text-muted-foreground">
            {exchange === null
              ? 'The request and the response, as the runner recorded them.'
              : `${agentName(exchange.agent)} · ${OUTCOME[exchange.outcome] ?? exchange.outcome}${exchange.reason === null ? '' : ` (${exchange.reason})`}`}
          </SheetDescription>
        </div>
        {state === 'loading' ? (
          <p className="px-6 py-6 text-[13px] text-muted-foreground">Loading the recorded request…</p>
        ) : state === 'error' ? (
          <p className="px-6 py-6 text-[13px] text-bad">
            Couldn&apos;t load the request.{' '}
            <button type="button" onClick={onRetry} className="font-medium underline">
              Retry
            </button>
          </p>
        ) : state === 'missing' || exchange === null ? (
          <p className="px-6 py-6 text-[13px] text-muted-foreground">This request is not recorded yet. It appears a moment after it is sent.</p>
        ) : (
          <div className="flex flex-col gap-5 px-6 py-5">
            <dl className="m-0 grid grid-cols-3 gap-3 text-[12.5px]">
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd className="m-0 font-semibold tabular-nums">{exchange.status ?? 'None'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Time</dt>
                <dd className="m-0 font-semibold tabular-nums">{exchange.durationMs === null ? 'None' : `${exchange.durationMs} ms`}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Sent at</dt>
                <dd className="m-0 font-semibold tabular-nums" suppressHydrationWarning>
                  {new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(exchange.at))}
                </dd>
              </div>
            </dl>
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-[13px] font-semibold">Request</h3>
              <p className="m-0 break-all font-mono text-[12px]">
                {exchange.method} {exchange.url}
              </p>
              <Headers headers={exchange.requestHeaders} />
              <Body text={exchange.requestBody} />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="m-0 text-[13px] font-semibold">Response</h3>
              <Headers headers={exchange.responseHeaders} />
              <Body text={exchange.responseBody} />
              <p className="m-0 text-[11.5px] text-muted-foreground">Bodies are excerpts. Test-account credentials are redacted by the runner.</p>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
