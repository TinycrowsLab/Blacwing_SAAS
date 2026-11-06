// One issue in three voices, never blurred (experience spec §1, §7): Claude's explanation (not verified), Blackwing's
// proof by the validator (probe and control side by side, replay count, no model) and Claude's fix suggestion, shown
// only when the run recorded one. Used by the results page and the finding detail page.
import { agentName } from '../../../lib/agents';
import { Chip, Icon, VoiceTag } from '../design';
import { Markdown } from '../markdown';

import type { FindingDetail } from './model';
import type { ReactNode } from 'react';

type Side = FindingDetail['evidence']['probe'];

/** `GET /rest/products/search?q=apple` from a full URL (the origin is the target, shown elsewhere). */
export function requestLine(side: Side): string | null {
  if (side.request === undefined) return null;
  let path = side.request.url;
  try {
    const u = new URL(side.request.url);
    path = `${u.pathname}${u.search}`;
  } catch {
    // keep the raw value
  }
  return `${side.request.method.toUpperCase()} ${path}`;
}

/** What the validator looked for, in words: "the response contains "http_requests_count"". */
export function oracleWords(oracle: FindingDetail['oracle']): string | null {
  const v = oracle.value;
  if (v === undefined || v === '') return null;
  switch (oracle.type) {
    case 'body_contains':
      return `the response contains “${v}”`;
    case 'body_regex':
      return `the response matches /${v}/`;
    case 'status_equals':
      return `the status is ${v}`;
    case 'header_contains':
      return `a header contains “${v}”`;
    default:
      return `${oracle.type ?? 'check'}: ${v}`;
  }
}

/** Proven, or why not: counts come from the stored replays, never from the model. */
export function proofSentence(f: FindingDetail): { proven: boolean; text: string } {
  if (f.evidence.reason !== undefined)
    return { proven: false, text: `Not proven: ${f.evidence.reason}. Kept back from the report.` };
  const n = f.evidence.replays.length;
  const matched = f.evidence.replays.filter((r) => r.matched).length;
  const control = f.replay?.control;
  const controlText =
    control === null || control === undefined
      ? ''
      : control.matched
        ? ', but the control matched too'
        : ', the control behaved as expected';
  return { proven: true, text: `Proven: replayed ${matched} of ${n} times${controlText}. No model involved.` };
}

function Label({ voice, children }: { readonly voice?: 'claude' | 'blackwing'; readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11.5px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
      {voice === undefined ? null : <VoiceTag voice={voice} />}
      <span className="normal-case tracking-normal [&_b]:font-semibold [&_b]:uppercase [&_b]:tracking-[0.04em]">
        {children}
      </span>
    </div>
  );
}

function ProofSide({
  title,
  note,
  side,
  verdict,
}: {
  readonly title: string;
  readonly note?: string;
  readonly side: Side;
  readonly verdict: { text: string; tone: 'ok' | 'neutral' } | null;
}) {
  const line = requestLine(side);
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-code">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2.5 text-[13px]">
        <span className="font-semibold text-foreground">{title}</span>
        {note === undefined ? null : <span className="text-[12px] text-muted-foreground">{note}</span>}
        {verdict === null ? null : (
          <span
            className={`ml-auto rounded-md px-2 py-0.5 font-mono text-[11.5px] font-medium ${verdict.tone === 'ok' ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-foreground'}`}
          >
            {verdict.text}
          </span>
        )}
      </div>
      <pre className="m-0 whitespace-pre-wrap break-all px-3.5 py-3 font-mono text-[12px] leading-5 text-foreground">
        {line ?? 'Not recorded'}
      </pre>
    </div>
  );
}

export function IssueBody({ finding, children }: { readonly finding: FindingDetail; readonly children?: ReactNode }) {
  const { probe, control } = finding.evidence;
  const proof = proofSentence(finding);
  const check = oracleWords(finding.oracle);
  const probeStatus = probe.response?.status;
  const controlStatus = control.response?.status;
  const controlMatched = finding.replay?.control?.matched;
  const remediation = finding.evidence.remediation?.trim() ?? '';
  return (
    <div className="flex flex-col gap-3.5">
      {finding.description === null || finding.description.trim() === '' ? null : (
        <section className="flex flex-col gap-2">
          <Label voice="claude">
            <b>What it means</b> · Claude&rsquo;s explanation, not verified
          </Label>
          <div className="rounded-xl border border-dashed border-border-strong bg-code px-4 py-3 text-[14px] leading-[22px] text-foreground">
            <Markdown text={finding.description} />
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <Label voice="blackwing">
          {proof.proven ? (
            <>
              <b>How it was proved</b> · by the validator
            </>
          ) : (
            <>
              <b>What the validator saw</b> · not proven
            </>
          )}
        </Label>
        <div className="grid gap-2.5 md:grid-cols-2">
          <ProofSide
            title="Probe"
            side={probe}
            verdict={probeStatus === undefined ? null : { text: `${probeStatus} · ${proof.proven ? 'matched' : 'sent'}`, tone: proof.proven ? 'ok' : 'neutral' }}
          />
          <ProofSide
            title="Control"
            note="the baseline"
            side={control}
            verdict={
              controlStatus === undefined
                ? null
                : { text: `${controlStatus}${controlMatched === undefined ? '' : controlMatched ? ' · matched' : ' · no match'}`, tone: 'neutral' }
            }
          />
        </div>
        {check === null ? null : (
          <p className="m-0 text-[12.5px] text-muted-foreground">
            Blackwing checked that {check}.
          </p>
        )}
        <p className={`m-0 flex items-start gap-2 text-[13px] leading-5 ${proof.proven ? 'text-ok' : 'text-muted-foreground'}`}>
          <span
            aria-hidden="true"
            className={`mt-[4px] size-2.5 shrink-0 rounded-full border-2 border-current ${proof.proven ? '' : 'border-dashed'}`}
          />
          {proof.text}
        </p>
      </section>

      {remediation === '' ? null : (
        <section className="flex flex-col gap-1.5">
          <Label voice="claude">
            <b>How to fix it</b> · Claude&rsquo;s suggestion, not verified
          </Label>
          <div className="text-[14px] leading-[22px] text-foreground">
            <Markdown text={remediation} />
          </div>
        </section>
      )}

      <div className="flex flex-wrap gap-1.5">
        {finding.cwe === null ? null : <Chip tone="neutral">{finding.cwe}</Chip>}
        {finding.owasp === null ? null : <Chip tone="neutral">OWASP {finding.owasp}</Chip>}
        {finding.agent === null ? null : (
          <Chip tone="neutral" title={finding.agent}>
            <Icon name="agent" size={12} />
            Found by the {agentName(finding.agent)}
          </Chip>
        )}
      </div>
      {finding.delivery === null ? null : (
        <p className={`m-0 flex items-center gap-1.5 text-[12.5px] ${finding.delivery.status === 'delivered' ? 'text-muted-foreground' : 'text-bad'}`}>
          <Icon name={finding.delivery.status === 'delivered' ? 'check' : 'warn'} size={13} />
          {finding.delivery.status === 'delivered'
            ? `Sent to your webhook (${finding.delivery.detail}).`
            : `Webhook delivery failed (${finding.delivery.detail}). The release itself stands.`}
        </p>
      )}
      {children}
    </div>
  );
}
