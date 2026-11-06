/* eslint-disable @typescript-eslint/no-magic-numbers -- display truncation (hashes) */
// The report card (experience spec §7): a receipt of what the audit did (the runner's numbers), what the report holds
// (released issues only), the download, the webhook line (truthful: the configured host, who can connect one, or a
// link to Settings when the status is unknown) and the ledger seal. Then the retest card, once the audit has ended.
import Link from 'next/link';

import { usd } from '../../../lib/plan-text';
import { Icon, SeverityChip } from '../design';
import { SEVERITIES } from './model';
import { ReportDownload, RunAgain } from './report-download';

import type { ReactNode } from 'react';

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span aria-hidden="true" className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-border-strong" />
      <span className="text-right font-semibold tabular-nums text-foreground [&_small]:text-[12px] [&_small]:font-normal [&_small]:text-muted-foreground">
        {children}
      </span>
    </div>
  );
}

export function ReportCard(props: {
  readonly runId: string;
  readonly requestId: string;
  readonly host: string;
  readonly severities: readonly string[];
  readonly released: number;
  readonly awaiting: number;
  /** Kept-back findings nobody has decided on yet: Download stays secondary until they are. */
  readonly undecided: number;
  readonly live: boolean;
  readonly cases: { executed: number; total: number };
  readonly requests: { used: number; cap: number };
  readonly cost: { used: number; cap: number };
  readonly gate2: { asked: number; label: string };
  /** null: the workspace settings could not be read, so the line is left out rather than guessed. */
  readonly webhook: { configured: boolean; host: string | null } | null;
  readonly ledgerHead: string | null;
}) {
  const n = props.severities.length;
  const counts = SEVERITIES.map((s) => [s, props.severities.filter((x) => x === s).length] as const).filter(
    ([, c]) => c > 0,
  );
  return (
    <div className="flex flex-col gap-3 lg:sticky lg:top-6">
      <section
        aria-labelledby="report-h"
        className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_8px_28px_rgba(31,23,4,.06)]"
      >
        <div className="flex flex-col gap-1 px-5 pb-3 pt-4">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-gold-ink">The report</span>
          <h2 id="report-h" className="m-0 break-all text-[17px] font-semibold text-foreground">
            {props.host}
          </h2>
        </div>
        <div className="flex flex-col gap-2.5 px-5">
          <Row label="Proven issues">{n}</Row>
          {counts.length === 0 ? null : (
            <ul className="m-0 grid list-none grid-cols-2 gap-1.5 p-0">
              {counts.map(([s, c]) => (
                <li key={s} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1">
                  <b className="min-w-4 text-[13px] tabular-nums text-foreground">{c}</b>
                  <SeverityChip severity={s} />
                </li>
              ))}
            </ul>
          )}
          <Row label="Test cases">
            {props.cases.executed.toLocaleString()} <small>of {props.cases.total.toLocaleString()}</small>
          </Row>
          <Row label="Requests sent">
            {props.requests.used.toLocaleString()} <small>of {props.requests.cap.toLocaleString()}</small>
          </Row>
          <Row label="Decisions asked">
            {props.gate2.asked} <small>{props.gate2.label}</small>
          </Row>
          <Row label="Model spend">
            {usd(Math.round(props.cost.used * 100) / 100)} <small>of {usd(props.cost.cap)}</small>
          </Row>
        </div>
        <p className="mx-5 mb-0 mt-3 border-t border-dashed border-border-strong pt-3 text-[13px] leading-5 text-muted-foreground">
          {n === 0 ? (
            props.live ? (
              'Nothing is proven yet. The report fills in as Claude proves issues.'
            ) : (
              'Nothing was proven, so the report lists what was tested and no issues.'
            )
          ) : (
            <>
              <b className="font-semibold text-foreground">
                {props.released} of {n} released.
              </b>{' '}
              The report includes released issues only
              {props.awaiting > 0 ? '; release the others to include them.' : '.'}
            </>
          )}
        </p>
        <div className="flex flex-col gap-2.5 px-5 pb-4 pt-3">
          <ReportDownload
            href={`/api/runs/${props.runId}/report`}
            primary={!props.live && props.awaiting === 0 && props.undecided === 0}
          />
          <p className="m-0 text-center text-[12.5px] leading-5 text-muted-foreground">
            {props.webhook === null ? (
              <Link href="/settings#webhook" className="font-medium text-gold-ink underline-offset-2 hover:underline">
                Where released issues are sent
              </Link>
            ) : props.webhook.configured ? (
              <>
                Released issues are also posted to{' '}
                <span className="font-medium text-foreground">{props.webhook.host ?? 'your webhook'}</span>.
              </>
            ) : (
              'Released issues stay in Blackwing. Ask your administrator to connect a webhook to send them to your tools.'
            )}
          </p>
        </div>
        {props.ledgerHead === null ? null : (
          <div className="flex items-center gap-2 border-t border-border bg-sidebar px-5 py-2.5 text-[12px] text-muted-foreground">
            <Icon name="shield" size={14} className="text-ok" />
            <span className="min-w-0 flex-1 truncate font-mono">
              ledger · sha256 {props.ledgerHead.slice(0, 4)}…{props.ledgerHead.slice(-4)}
            </span>
            <Link href="/ledger#verify" className="font-medium text-gold-ink underline-offset-2 hover:underline">
              Verify
            </Link>
          </div>
        )}
      </section>
      {props.live ? null : (
      <section aria-labelledby="again-h" className="flex flex-col gap-1.5 rounded-[14px] border border-border bg-card px-4 py-3.5">
        <h2 id="again-h" className="m-0 text-[14.5px] font-semibold text-foreground">
          After you fix them
        </h2>
        <p className="m-0 text-[13px] leading-5 text-muted-foreground">
          Run the same audit again. It keeps your answers and goes straight to your approval.
        </p>
        <div className="pt-1.5">
          <RunAgain requestId={props.requestId} />
        </div>
      </section>
      )}
    </div>
  );
}
