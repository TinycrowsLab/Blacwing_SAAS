/* eslint-disable @typescript-eslint/no-magic-numbers -- display truncation (hashes) */
// The report card (experience spec §7): a receipt of what the audit did (the runner's numbers), what the report holds
// (released issues only), the download, the webhook line (truthful: the configured host, or "connect a webhook" linking
// to Settings, never a tool we do not know about) and the ledger seal. Then the retest card, once the audit has ended.

import { usd } from '../../../lib/plan-text';
import { Icon } from '../design';
import { SEVERITIES } from './model';
import { NavLink } from './nav-link';
import { ReportDownload, RunAgain } from './report-download';

import type { ReactNode } from 'react';

/** The severity chip with its count inside ("1 Critical"), in the severity's own tone (the design's chip pairs). */
const SEVERITY_TONE: Readonly<Record<string, string>> = {
  critical: 'bg-crit text-crit-fg',
  high: 'bg-high-soft text-high',
  medium: 'bg-med-soft text-med',
  low: 'bg-low-soft text-low',
  info: 'bg-sinfo-soft text-sinfo',
};
const LEVEL: Readonly<Record<string, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/** The same signal-bar glyph as the issue's SeverityChip (design.tsx), drawn here because the chip carries a count. */
function Bars({ level }: { readonly level: number }) {
  return (
    <span aria-hidden="true" className="inline-flex h-2.5 items-end gap-px">
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-[2.5px] rounded-[1px] bg-current"
          style={{ height: `${3 + i * 1.75}px`, opacity: i <= level ? 1 : 0.25 }}
        />
      ))}
    </span>
  );
}
const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span
        aria-hidden="true"
        className="min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-border-strong"
      />
      <span className="text-right font-semibold tabular-nums text-foreground [&_small]:text-[12px] [&_small]:font-normal [&_small]:text-muted-foreground">
        {children}
      </span>
    </div>
  );
}

/** What else the report line says once some issues are in: who is waiting, who was dismissed. */
function inReportNote(awaiting: number, dismissed: number): string {
  const parts = [
    awaiting > 0 ? `${awaiting} still ${awaiting === 1 ? 'awaits' : 'await'} your release` : null,
    dismissed > 0 ? `${dismissed} dismissed` : null,
  ].filter((x): x is string => x !== null);
  return parts.length === 0
    ? 'Only released issues go into it.'
    : `${parts.join(', ')}. Only released issues go into it.`;
}

export function ReportCard(props: {
  readonly runId: string;
  readonly requestId: string;
  /** The target's name, as everywhere else; its host is said second. */
  readonly name: string;
  readonly host: string;
  /** Severities of every proven issue (the same count as the headline). */
  readonly severities: readonly string[];
  /** Proven issues dismissed: proven, never reported. */
  readonly dismissed: number;
  readonly released: number;
  readonly awaiting: number;
  readonly live: boolean;
  readonly cases: { executed: number; total: number };
  readonly requests: { used: number; cap: number };
  readonly cost: { used: number; cap: number };
  readonly gate2: { asked: number; label: string };
  /** null: the workspace settings could not be read, so the line links to Settings rather than guess. */
  readonly webhook: { configured: boolean; host: string | null } | null;
  readonly ledgerHead: string | null;
  /** Planned test cases the run never tried (the runner's coverage): offers "Continue with untried cases". */
  readonly untried: number;
}) {
  const n = props.severities.length;
  const counts = SEVERITIES.map(
    (s) => [s, props.severities.filter((x) => x === s).length] as const,
  ).filter(([, c]) => c > 0);
  return (
    <div className="flex flex-col gap-3 lg:sticky lg:top-6">
      <section
        aria-labelledby="report-h"
        className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_8px_28px_rgba(31,23,4,.06)]"
      >
        <div className="flex flex-col gap-1 px-5 pb-3 pt-4">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-gold-ink">
            The report
          </span>
          <h2 id="report-h" className="m-0 break-words text-[17px] font-semibold text-foreground">
            {props.name}
          </h2>
          {props.host === props.name ? null : (
            <span className="break-all font-mono text-[12px] text-muted-foreground">
              {props.host}
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2.5 px-5">
          <Row label="Proven issues">{n}</Row>
          {counts.length === 0 ? null : (
            <ul className="m-0 grid list-none grid-cols-2 gap-1.5 p-0" aria-label="By severity">
              {counts.map(([s, c]) => (
                <li
                  key={s}
                  className={`inline-flex h-[24px] items-center gap-1.5 rounded-md px-2 text-[12px] font-medium ${SEVERITY_TONE[s] ?? ''}`}
                >
                  <Bars level={LEVEL[s] ?? 0} />
                  <span>
                    <b className="font-semibold tabular-nums">{c}</b> {cap(s)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Row label="Test cases">
            {props.cases.executed.toLocaleString()}{' '}
            <small>of {props.cases.total.toLocaleString()}</small>
          </Row>
          <Row label="Requests sent">
            {props.requests.used.toLocaleString()}{' '}
            <small>of {props.requests.cap.toLocaleString()}</small>
          </Row>
          <Row label="Decisions asked">
            {props.gate2.asked}
            {props.gate2.asked === 0 ? null : <small> · {props.gate2.label}</small>}
          </Row>
          <Row label="Model spend">
            {usd(Math.round(props.cost.used * 100) / 100)} <small>of {usd(props.cost.cap)}</small>
          </Row>
        </div>
        <p className="mx-5 mb-0 mt-3 border-t border-dashed border-border-strong pt-3 text-[13px] leading-5 text-muted-foreground">
          {props.released > 0 ? (
            <>
              <b className="font-semibold text-foreground">
                {props.released === n
                  ? `All ${n} in the report.`
                  : `${props.released} of ${n} in the report.`}
              </b>{' '}
              {inReportNote(props.awaiting, props.dismissed)}
            </>
          ) : n > props.dismissed ? (
            <>
              <b className="font-semibold text-foreground">None released yet.</b> The report
              includes released issues only; release them to include them.
            </>
          ) : n > 0 ? (
            'Every proven issue was dismissed, so the report lists what was tested and no issues.'
          ) : props.live ? (
            'Nothing is proven yet. The report fills in as Claude proves issues.'
          ) : (
            'Nothing was proven, so the report lists what was tested and no issues.'
          )}
        </p>
        <div className="flex flex-col gap-2.5 px-5 pb-4 pt-3">
          {/* Gold once every proven issue is decided: kept-back ones are optional reviews, not a gate on the report. */}
          <ReportDownload
            href={`/api/runs/${props.runId}/report`}
            primary={!props.live && props.awaiting === 0}
            note={n > 0 ? `${props.released} of ${n} released` : 'no issues proven'}
          />
          <p className="m-0 flex items-start gap-1.5 text-[12.5px] leading-5 text-muted-foreground">
            <Icon name="arrow" size={13} className="mt-[3px] shrink-0" />
            {props.webhook?.configured === true ? (
              <span>
                Released issues are also posted to{' '}
                <span className="font-medium text-foreground">
                  {props.webhook.host ?? 'your webhook'}
                </span>
                .
              </span>
            ) : props.webhook === null ? (
              // The status could not be read: point to where it is shown rather than guess.
              <NavLink
                href="/settings#webhook"
                className="font-medium text-gold-ink underline-offset-2 hover:underline"
              >
                See where released issues are sent
              </NavLink>
            ) : (
              <span>
                Send released issues to your tools:{' '}
                <NavLink
                  href="/settings#webhook"
                  className="font-medium text-gold-ink underline-offset-2 hover:underline"
                >
                  connect a webhook
                </NavLink>
              </span>
            )}
          </p>
        </div>
        {props.ledgerHead === null ? null : (
          <div className="flex items-center gap-2 border-t border-border bg-sidebar px-5 py-2.5 text-[12px] text-muted-foreground">
            <Icon name="shield" size={14} className="text-ok" />
            <span className="min-w-0 flex-1 truncate font-mono">
              ledger · sha256 {props.ledgerHead.slice(0, 4)}…{props.ledgerHead.slice(-4)}
            </span>
            <NavLink
              href="/ledger#verify"
              className="font-medium text-gold-ink underline-offset-2 hover:underline"
            >
              Verify
            </NavLink>
          </div>
        )}
      </section>
      {props.live ? null : (
        <section
          aria-labelledby="again-h"
          className="flex flex-col gap-1.5 rounded-[14px] border border-border bg-card px-4 py-3.5"
        >
          <h2 id="again-h" className="m-0 text-[14.5px] font-semibold text-foreground">
            After you fix them
          </h2>
          <p className="m-0 text-[13px] leading-5 text-muted-foreground">
            Run the same audit again. It keeps your answers and goes straight to your approval.
          </p>
          <div className="pt-1.5">
            <RunAgain requestId={props.requestId} />
          </div>
          {props.untried === 0 ? null : (
            <>
              <p className="m-0 border-t border-dashed border-border-strong pt-3 text-[13px] leading-5 text-muted-foreground">
                {props.untried === 1 ? '1 planned test case was' : `${props.untried} planned test cases were`} not run or were
                blocked. A new
                plan can pick them up; it goes to your approval first.
              </p>
              <div className="pt-1.5">
                <RunAgain requestId={props.requestId} untriedFromRunId={props.runId} label="Continue with untried cases" />
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
