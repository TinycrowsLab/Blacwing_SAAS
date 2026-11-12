/* eslint-disable @typescript-eslint/no-magic-numbers -- report layout values */
// The run report people download and send on (experience spec §7, §8). The API gives the run's released findings as
// JSON; this file words them the way the console does: the target's name, plain words for every setting, the issues
// most severe first, and the three voices kept apart (Blackwing's proof, Blackwing AI's explanation and Blackwing AI's fix, the
// last two marked "not verified"). It holds released issues only, so the agent's run summary (written about every
// suspected issue, dismissed and unreleased ones too) never goes in. Pure functions, no IO; all text is escaped.
import { z } from 'zod';

import { scrubDeep } from '@blackwing/errors/scrub';

import { agentName } from '../../../lib/agents';
import { coverageSchema, intelSchema, type Intel } from '../../../lib/schemas';
import { escapeHtml as esc, markdownToHtml } from '../markdown';
import { identityOf, oracleWords, plainReason, PROOF_BY, proofSentence, requestLine } from './issue-body';
import { bySeverity, duration, findingDetailSchema, notTested, SEVERITIES, type FindingDetail } from './model';

/** The API's `GET /runs/:id/report?format=json`: only what the report says is read; the rest passes through. */
export const reportSourceSchema = z
  .object({
    run: z
      .object({
        id: z.string(),
        startedAt: z.string().nullable().default(null),
        finishedAt: z.string().nullable().default(null),
        requestsUsed: z.number().default(0),
        costUsd: z.number().default(0),
        budget: z.object({ requests: z.number(), seconds: z.number(), costUsd: z.number() }),
        /** Why the run ended (from its run.completed, run.failed or run.killed event); null on older reports. */
        endReason: z.string().nullable().default(null),
        /** Only Blackwing AI's own "not covered" note is read from it, marked not verified; the rest never goes in. */
        summary: z.string().nullable().default(null),
      })
      .loose(),
    asset: z
      .object({
        name: z.string(),
        baseUrl: z.string(),
        ownership: z
          .object({
            status: z.string(),
            verifiedBy: z.string().nullable(),
            verifiedAt: z.string().nullable(),
          })
          .partial()
          .default({}),
      })
      .loose(),
    request: z
      .object({
        objective: z.string().default(''),
        intrusiveness: z.string().default('passive'),
        excludedPaths: z.array(z.string()).default([]),
        testAccounts: z.array(z.object({ role: z.string() })).default([]),
        approver: z.object({ name: z.string().nullable() }).nullable().default(null),
        decisionReason: z.string().nullable().default(null),
        decidedAt: z.string().nullable().default(null),
      })
      .loose(),
    findings: z.array(findingDetailSchema),
    /** Suspected findings the validator could not prove: never released, listed in an appendix marked "not proven". */
    keptBack: z.array(findingDetailSchema).default([]),
    /** What the runner recorded about coverage; null for runs from before it did. */
    coverage: coverageSchema.nullable().default(null),
    /** The threat-intel phase (`externalExposure` in the API's JSON); null for runs from before it existed. */
    externalExposure: intelSchema.nullable().catch(null).default(null),
    /** The AI-written executive summary: not verified, absent when none was written. */
    executiveSummary: z.object({ markdown: z.string() }).loose().nullable().catch(null).default(null),
  })
  .loose();
export type ReportSource = z.infer<typeof reportSourceSchema>;

export const REPORT_FORMATS = ['html', 'md', 'json', 'sarif'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

const LIMITS = [
  'Severity is the label Blackwing AI proposed, not a computed CVSS score.',
  'Explanations and fixes are written by Blackwing AI and are not verified. The proof (replays and control) is.',
  'Blackwing AI proposed each check and its control; Blackwing replayed them. A finding holds for the state the site was in then.',
  'Detection only: each probe is the least needed to show the issue.',
  'No browser is used, so DOM-based XSS is not tested.',
  'Tokens, cookies and passwords in the evidence are redacted by Blackwing.',
  'Only issues a person released are listed in the findings. Issues still awaiting release or dismissed are left out. Kept-back issues appear only in the appendix, marked not proven.',
];

/** Base64 PNGs of each finding's proof screenshots, by finding id (read through the API by the report route). */
export type ShotImages = ReadonlyMap<string, { readonly probe?: string; readonly control?: string }>;
const SHOT_KINDS = ['probe', 'control'] as const;

/** Markdown cannot hold the images: it names them, where the HTML report and the console show them. */
function shotsMarkdown(f: FindingDetail, images: ShotImages | undefined): string[] {
  const have = SHOT_KINDS.filter((k) => images?.get(f.id)?.[k] !== undefined || f.evidence.screenshots?.[k] !== undefined);
  if (have.length === 0)
    return f.evidence.screenshots?.note === undefined ? [] : [`Proof screenshot: ${f.evidence.screenshots.note}`, ''];
  return [
    `Proof screenshot (${have.join(' / ')}): PNG, embedded in the HTML report and shown on the finding in the console (\`/api/findings/${f.id}/screenshots/<probe|control>\`).`,
    '',
  ];
}

/** The pair as base64 images (probe vs control), or the capture's note when none was taken. */
function shotsHtml(f: FindingDetail, images: ShotImages | undefined): string {
  const mine = images?.get(f.id);
  const have = SHOT_KINDS.filter((k) => mine?.[k] !== undefined);
  if (have.length === 0)
    return f.evidence.screenshots?.note === undefined ? '' : `\n<p class="meta">Proof screenshot: ${esc(f.evidence.screenshots.note)}</p>`;
  const figure = (k: (typeof SHOT_KINDS)[number]): string =>
    `<figure style="margin:0;flex:1 1 360px;min-width:0"><figcaption class="meta"><b>${k === 'probe' ? 'Probe' : 'Control'}</b></figcaption><img alt="Proof screenshot: ${k}" style="max-width:100%;border:1px solid var(--line)" src="data:image/png;base64,${esc(mine?.[k] ?? '')}"></figure>`;
  return `\n<h4>Proof screenshot <span>· probe vs control, taken by a headless browser</span></h4>\n<div style="display:flex;flex-wrap:wrap;gap:12px">${have.map((k) => figure(k)).join('')}</div>`;
}

const laterThanStart = (at: string | null | undefined, start: string | null): boolean =>
  at !== null && at !== undefined && start !== null && Date.parse(at) > Date.parse(start);
const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const usd = (n: number): string => `$${n.toFixed(2)}`;

/** A date people read anywhere: day, month, year and time in UTC, said as UTC (the server's zone is nobody's). */
function when(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const text = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(d);
  return `${text} UTC`;
}

const careful = (intrusiveness: string): string =>
  intrusiveness === 'active_safe'
    ? 'Probe gently (active, safe requests only)'
    : 'Only look, never touch (passive)';

/** "1 high, 4 medium and 1 low". */
function severityWords(findings: readonly Pick<FindingDetail, 'severity'>[]): string {
  const parts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return parts.length < 2
    ? (parts[0] ?? '')
    : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

/**
 * The report's opening sentence: how many issues were released to it, how many of those the validator proved and how
 * many a person released without proof, by severity.
 */
export function reportLede(findings: readonly Pick<FindingDetail, 'severity' | 'evidence'>[]): string {
  if (findings.length === 0)
    return 'This report lists no issues: none were released from this audit. What was and was not tested is described below.';
  const unproven = findings.filter((f) => f.evidence.reason !== undefined).length;
  const proven = findings.length - unproven;
  const split =
    unproven === 0
      ? proven === 1
        ? ', proven by replay'
        : `, all ${proven} proven by replay`
      : ` (${proven} proven, ${unproven} released without proof)`;
  return `${plural(findings.length, 'issue was', 'issues were')} released to this report${split}: ${severityWords(findings)}.`;
}

/** `blackwing-report-local-shop-2026-11-06.html`: safe in a header, sortable, and says what it is. */
export function reportFilename(src: ReportSource, format: ReportFormat): string {
  const slug =
    src.asset.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || src.run.id.slice(0, 8);
  const day = (src.run.startedAt ?? src.run.finishedAt ?? '').slice(0, 10);
  const ext = format === 'sarif' ? 'sarif' : format;
  return `blackwing-report-${slug}${/^\d{4}-\d{2}-\d{2}$/.test(day) ? `-${day}` : ''}.${ext}`;
}

/** "Configured: alice, bob · used in 14 requests (alice 14, bob 0)", from what was actually sent. */
function signedIn(src: ReportSource): string {
  const roles = src.request.testAccounts.map((a) => a.role);
  if (roles.length === 0) return 'None';
  const configured = `Configured: ${roles.join(', ')}`;
  if (src.coverage === null) return `${configured} · how often they were used was not recorded`;
  const used = src.coverage.rolesUsed;
  const total = roles.reduce((n, r) => n + (used[r] ?? 0), 0);
  return total === 0
    ? `${configured} · not used in any request`
    : `${configured} · used in ${plural(total, 'request', 'requests')} (${roles.map((r) => `${r} ${used[r] ?? 0}`).join(', ')})`;
}

/** The facts about the audit, in the words of the plan the person approved. */
function facts(src: ReportSource): [string, string][] {
  const { run, asset, request } = src;
  const cases = src.coverage?.cases ?? [];
  const ran = cases.filter((c) => c.status === 'executed').length;
  const owner = asset.ownership;
  const verified =
    owner.status === 'verified'
      ? [
          'Ownership verified',
          owner.verifiedBy === null || owner.verifiedBy === undefined
            ? null
            : `by ${owner.verifiedBy}`,
          // The proof in force for this audit: a re-verification after the start says nothing about this audit.
          when(owner.verifiedAt) === null || laterThanStart(owner.verifiedAt, run.startedAt)
            ? null
            : `on ${when(owner.verifiedAt)}`,
          when(run.startedAt) === null ? null : `and re-checked when the audit started, ${when(run.startedAt)}`,
        ]
          .filter(Boolean)
          .join(' ')
      : 'Ownership not verified';
  const approved =
    request.approver === null
      ? 'Not recorded'
      : [
          request.approver.name ?? 'An administrator',
          when(request.decidedAt) === null ? null : `on ${when(request.decidedAt)}`,
          request.decisionReason === null || request.decisionReason === ''
            ? null
            : `· reason: “${request.decisionReason}”`,
        ]
          .filter(Boolean)
          .join(' ');
  const took =
    run.startedAt === null || run.finishedAt === null
      ? null
      : duration(Date.parse(run.finishedAt) - Date.parse(run.startedAt));
  const rows: [string, string | null][] = [
    ['Target', `${asset.name} (${asset.baseUrl}). ${verified}.`],
    [
      'What you asked for',
      request.objective.trim() === '' ? 'The whole site' : request.objective.trim(),
    ],
    ['Test cases', cases.length === 0 ? null : `${ran} of ${plural(cases.length, 'planned test case', 'planned test cases')} ran`],
    ['How careful', careful(request.intrusiveness)],
    ['Left out', request.excludedPaths.length === 0 ? 'Nothing' : request.excludedPaths.join(', ')],
    ['Signed-in testing', signedIn(src)],
    ['Approved by', approved],
    [
      'When',
      [when(run.startedAt), took === null ? null : `ran for ${took}`].filter(Boolean).join(', ') ||
        null,
    ],
    [
      'Requests sent',
      `${run.requestsUsed.toLocaleString('en-GB')} of ${run.budget.requests.toLocaleString('en-GB')} allowed`,
    ],
    ['Model spend', `${usd(run.costUsd)} of ${usd(run.budget.costUsd)}`],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null);
}

/** One line about the release: who, when and why. */
function releaseLine(f: FindingDetail): string | null {
  const t = f.triage;
  if (t === null) return null;
  return [
    `Released${t.by === null ? ' automatically' : ` by ${t.by}`}`,
    when(t.at) === null ? null : `on ${when(t.at)}`,
    t.reason === null || t.reason === '' ? null : `· reason: “${t.reason}”`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Exposure proofs (no control possible) say so; the rest describe the probe/control pair. */
const isExposure = (f: FindingDetail): boolean => f.evidence.proof?.delta === 'none';
const checkedLine = (f: FindingDetail, check: string): string =>
  isExposure(f)
    ? `Blackwing checked that ${check} on every replay.`
    : `Blackwing checked that ${check}: the probe should show it, the control should not.`;
const controlNote = (f: FindingDetail): string =>
  isExposure(f) ? 'none: the data is open to anyone signed out' : 'a similar request that should not show it';

function sideWords(side: FindingDetail['evidence']['probe']): string {
  const line = requestLine(side);
  if (line === null) return 'Not recorded';
  const who = identityOf(side);
  const sent = who === null ? line : `${line} (${who})`;
  return side.response === undefined ? sent : `${sent} → HTTP ${side.response.status}`;
}

/** The proof in the report's words: a released issue the validator did not prove says who released it anyway. */
function proofOf(f: FindingDetail): { proven: boolean; text: string; heading: string } {
  const proof = proofSentence(f);
  return proof.proven
    ? { ...proof, heading: 'How it was proved' }
    : {
        proven: false,
        text: proof.text.replace('Kept back from the report.', 'A person released it without proof.'),
        heading: 'What the validator saw',
      };
}

function meta(f: FindingDetail): string {
  return [
    f.cwe,
    f.owasp === null ? null : `OWASP ${f.owasp}`,
    f.agent === null ? null : `Found by the ${agentName(f.agent)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The replays, one row each: number, HTTP status, whether the expected result showed. */
const replayRows = (f: FindingDetail): { n: number; status: number; matched: boolean }[] => [...f.evidence.replays];
const controlExcerpt = (f: FindingDetail): string => f.evidence.control.response?.bodyExcerpt ?? '';
const replaySummary = (f: FindingDetail): string => {
  const rows = replayRows(f);
  if (rows.length === 0) return 'No replays recorded.';
  const matched = rows.filter((r) => r.matched).length;
  const control = f.replay?.control;
  return `Replay result: ${matched} of ${rows.length} replays showed the issue${
    control === null || control === undefined
      ? ''
      : `; negative control returned HTTP ${control.status} and ${control.matched ? 'matched too' : 'behaved as expected'}`
  }.`;
};
const keptReason = (f: FindingDetail): string =>
  f.evidence.reason === undefined ? 'the validator did not prove it' : plainReason(f.evidence.reason);

const title = (src: ReportSource): string => `Security audit of ${src.asset.name}`;

/** "What was not tested and why": the runner's case record, the plan's exclusions, and the fixed limits. */
function notTestedOf(src: ReportSource): { rows: { what: string; why: string }[]; note: string | null; recorded: boolean } {
  const n = notTested({ coverage: src.coverage, endReason: src.run.endReason, excludedPaths: src.request.excludedPaths, summary: src.run.summary });
  return { rows: [...n.rows], note: n.note, recorded: n.recorded };
}

const NOT_RECORDED =
  'Blackwing did not record test-case coverage for this audit, so it cannot list the cases that did not run.';
const NO_GAPS = 'Every planned test case ran, and the plan left nothing out.';

const INTEL_BASIS: Readonly<Record<Intel['items'][number]['basis'], string>> = {
  finding: 'confirmed finding',
  observed: 'observed',
  unverified: 'intel, not verified',
};
const NO_INTEL = 'No threat-intel phase was recorded for this audit.';

/** "External exposure": the public view of the organisation, from the passive threat-intel phase. */
function exposureIntro(intel: Intel): string {
  return `Passive, public-source threat intel gathered before testing${intel.domains.length === 0 ? '' : ` for ${intel.domains.join(', ')}`}. Organisation level only: secrets are redacted and nothing about individuals is collected.`;
}

export const SUMMARY_TAG = 'Written by Blackwing AI · not verified';

/** The AI executive summary without its own top heading (the report adds that), or null when there is none. */
function summaryBody(src: ReportSource): string | null {
  const text = src.executiveSummary?.markdown.trim() ?? '';
  const body = text.replace(/^#{1,2}\s*Executive summary\s*\n/i, '').trim();
  return body === '' ? null : body;
}

export function renderMarkdown(src: ReportSource, findings: readonly FindingDetail[], images?: ShotImages): string {
  const out: string[] = [
    `# ${title(src)}`,
    '',
    `Blackwing report · ${src.asset.baseUrl}`,
    '',
    reportLede(findings),
    '',
  ];
  const summary = summaryBody(src);
  if (summary !== null) out.push('## Executive summary', '', `_${SUMMARY_TAG}._`, '', ...summary.split('\n').map((l) => (/^#{1,2}\s/.test(l) ? `#${l}` : l)), '');
  out.push('## About this audit', '', ...facts(src).map(([k, v]) => `- **${k}:** ${v}`), '');
  findings.forEach((f, i) => {
    const proof = proofOf(f);
    const check = oracleWords(f.oracle);
    const remediation = f.evidence.remediation?.trim() ?? '';
    out.push(`## ${i + 1}. ${f.title}`, '', `**${cap(f.severity)}** · ${meta(f)}  `);
    const released = releaseLine(f);
    if (released !== null) out.push(released);
    out.push(
      '',
      `### ${proof.heading} (${PROOF_BY})`,
      '',
      proof.text,
    );
    if (check !== null) out.push('', checkedLine(f, check));
    out.push(
      '',
      `- **Probe** (the request that shows the issue): \`${sideWords(f.evidence.probe)}\``,
      `- **Control** (${controlNote(f)}): \`${sideWords(f.evidence.control)}\``,
      '',
    );
    const excerpt = f.evidence.probe.response?.bodyExcerpt ?? '';
    if (excerpt !== '')
      out.push('What the site answered to the probe (excerpt):', '', '```', excerpt, '```', '');
    const ctl = controlExcerpt(f);
    if (ctl !== '')
      out.push('What the site answered to the control (excerpt):', '', '```', ctl, '```', '');
    out.push(...shotsMarkdown(f, images));
    out.push(replaySummary(f), '');
    if (replayRows(f).length > 0)
      out.push(
        '| Replay | HTTP status | Expected result shown |',
        '|---|---|---|',
        ...replayRows(f).map((r) => `| ${r.n} | ${r.status} | ${r.matched ? 'yes' : 'no'} |`),
        '',
      );
    if (f.reproCurl !== '')
      out.push(
        'Reproduce it (run it only against a copy you own):',
        '',
        '```sh',
        f.reproCurl,
        '```',
        '',
      );
    if (f.description !== null && f.description.trim() !== '')
      out.push(
        '### What it means (Blackwing AI’s explanation, not verified)',
        '',
        f.description.trim(),
        '',
      );
    if (remediation !== '')
      out.push('### How to fix it (Blackwing AI’s suggestion, not verified)', '', remediation, '');
  });
  const intel = src.externalExposure;
  out.push('## External exposure', '');
  if (intel === null) out.push(NO_INTEL, '');
  else {
    out.push(exposureIntro(intel), '');
    if (intel.skipped !== null) out.push(`${intel.skipped}.`, '');
    out.push(...intel.sources.map((x) => `- ${x.name}: ${x.note}`), '');
    out.push(
      ...(intel.items.length === 0
        ? ['No exposure items were found.']
        : intel.items.map((i) => `- **${i.title}** (${i.severity}, ${INTEL_BASIS[i.basis]}): ${i.detail}`)),
      '',
    );
    if (intel.discoveredHosts.length > 0)
      out.push(`Hosts discovered in public sources outside the approved scope (reported, not tested): ${intel.discoveredHosts.join(', ')}`, '');
  }
  const gaps = notTestedOf(src);
  const kept = [...src.keptBack].sort(bySeverity);
  out.push('## What was not tested and why', '');
  if (!gaps.recorded) out.push(NOT_RECORDED, '');
  if (gaps.rows.length > 0) out.push(...gaps.rows.map((r) => `- **${r.what}:** ${r.why}`), '');
  else if (gaps.recorded) out.push(NO_GAPS, '');
  if (gaps.note !== null) out.push('Blackwing AI’s own note (not verified):', '', ...gaps.note.split('\n').map((l) => `> ${l}`), '');
  out.push('## Limits of this report', '', ...LIMITS.map((l) => `- ${l}`), '');
  out.push(
    '## Appendix: kept-back findings (NOT PROVEN)',
    '',
    kept.length === 0
      ? 'No suspected issues were kept back in this audit.'
      : 'These issues were suspected but the validator could not prove them. They are NOT proven, were not released and are not findings of this report. They are listed so you can judge them yourself.',
    '',
  );
  kept.forEach((f, i) => {
    out.push(
      `### K${i + 1}. ${f.title} (not proven)`,
      '',
      `${cap(f.severity)} (proposed) · ${meta(f)}  `,
      `Why it is not proven: ${keptReason(f)}.`,
      '',
      `- **Probe:** \`${sideWords(f.evidence.probe)}\``,
      `- **Control:** \`${sideWords(f.evidence.control)}\``,
      '',
    );
    if (f.description !== null && f.description.trim() !== '')
      out.push('Blackwing AI’s explanation (not verified):', '', f.description.trim(), '');
  });
  return out.join('\n');
}

// The downloaded file stands alone (no stylesheet of ours reaches it), so the design tokens are copied in by value:
// these mirror --crit-bg, --high, --med, --low and their -soft pairs, and STYLE's variables mirror the light theme
// in app/globals.css. Change them together.
const SEV_STYLE: Readonly<Record<string, string>> = {
  critical: 'background:#6e1520;color:#fff',
  high: 'background:#fcedeb;color:#b42318',
  medium: 'background:#fdf1e7;color:#a8450a',
  low: 'background:#eef0f3;color:#4a5568',
  info: 'background:#f0f1f3;color:#4b5160',
};

// Solid, brand-aligned fills for the charts (the chips keep their soft pairs above). Inline SVG only: the file is
// downloaded and must render offline, so no chart library and no external script ever runs in it.
const SEV_FILL: Readonly<Record<string, string>> = {
  critical: '#6e1520',
  high: '#c0392b',
  medium: '#c2740a',
  low: '#6b7280',
  info: '#a5abb5',
};
const COVER_FILL: Readonly<Record<string, string>> = {
  executed: '#1b7a3e',
  blocked: '#c2740a',
  model_declined: '#9aa0ab',
  skipped: '#b8bcc4',
  not_run: '#e0ddd4',
};
const COVER_LABEL: Readonly<Record<string, string>> = {
  executed: 'Executed',
  blocked: 'Blocked',
  model_declined: 'Model declined',
  skipped: 'Skipped',
  not_run: 'Not run',
};
const COVER_ORDER = ['executed', 'blocked', 'model_declined', 'skipped', 'not_run'] as const;

interface Seg {
  readonly label: string;
  readonly value: number;
  readonly color: string;
}

/** A donut from segments, sized to its viewBox with the total in the hole; an empty set shows one faint ring. */
function donutSvg(segments: readonly Seg[], centreTop: string, centreSub: string): string {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  const cx = 70;
  const cy = 70;
  const sw = 20;
  let offset = 0;
  const arcs =
    total === 0
      ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>`
      : segments
          .filter((s) => s.value > 0)
          .map((s) => {
            const len = (s.value / total) * C;
            const el = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
            offset += len;
            return el;
          })
          .join('');
  return `<svg viewBox="0 0 140 140" width="132" height="132" role="img" aria-label="${esc(`${centreTop} ${centreSub}`)}">${arcs}<text x="70" y="66" text-anchor="middle" font-size="30" font-weight="700" fill="var(--fg)">${esc(centreTop)}</text><text x="70" y="86" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(centreSub)}</text></svg>`;
}

/** A legend of segments: swatch, label, value. Zero-value segments are dropped. */
function legendHtml(segments: readonly Seg[]): string {
  const rows = segments.filter((s) => s.value > 0);
  if (rows.length === 0) return '<p class="meta" style="margin:0">No data recorded.</p>';
  return `<ul class="legend">${rows
    .map((s) => `<li><span class="sw" style="background:${s.color}"></span>${esc(s.label)}<b>${s.value.toLocaleString('en-GB')}</b></li>`)
    .join('')}</ul>`;
}

/** A full-width stacked bar; widths as SVG percentages so it scales. Empty renders one faint track. */
function stackedBar(segments: readonly Seg[]): string {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total === 0)
    return '<div class="bar"><svg viewBox="0 0 100 8" preserveAspectRatio="none"><rect width="100" height="8" fill="var(--line)"/></svg></div>';
  let x = 0;
  const rects = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const w = (s.value / total) * 100;
      const r = `<rect x="${x.toFixed(3)}" y="0" width="${w.toFixed(3)}" height="8" fill="${s.color}"/>`;
      x += w;
      return r;
    })
    .join('');
  return `<div class="bar"><svg viewBox="0 0 100 8" preserveAspectRatio="none">${rects}</svg></div>`;
}

const fmt = (n: number): string => n.toLocaleString('en-GB');

/** The headline metric tiles of the dashboard, from the plan and what the runner recorded. */
function metricTiles(src: ReportSource, findings: readonly FindingDetail[]): { value: string; label: string; sub: string }[] {
  const crit = findings.filter((f) => f.severity === 'critical').length;
  const high = findings.filter((f) => f.severity === 'high').length;
  const cases = src.coverage?.cases ?? [];
  const ran = cases.filter((c) => c.status === 'executed').length;
  const took =
    src.run.startedAt === null || src.run.finishedAt === null
      ? '—'
      : duration(Date.parse(src.run.finishedAt) - Date.parse(src.run.startedAt));
  return [
    { value: fmt(findings.length), label: 'Issues released', sub: 'proven, in this report' },
    { value: fmt(crit + high), label: 'Critical & high', sub: 'need priority attention' },
    { value: cases.length === 0 ? '—' : `${ran}/${cases.length}`, label: 'Test cases run', sub: 'executed of planned' },
    { value: fmt(src.run.requestsUsed), label: 'Requests sent', sub: `of ${fmt(src.run.budget.requests)} allowed` },
    { value: took, label: 'Duration', sub: 'wall-clock' },
    { value: usd(src.run.costUsd), label: 'Model spend', sub: `of ${usd(src.run.budget.costUsd)}` },
  ];
}

/** The "Summary at a glance" dashboard: metric tiles, a severity donut and a coverage bar. */
function dashboard(src: ReportSource, findings: readonly FindingDetail[]): string {
  const sevSegs: Seg[] = SEVERITIES.map((s) => ({
    label: cap(s),
    value: findings.filter((f) => f.severity === s).length,
    color: SEV_FILL[s] ?? SEV_FILL.info ?? '#999',
  }));
  const cases = src.coverage?.cases ?? [];
  const covSegs: Seg[] = COVER_ORDER.map((k) => ({
    label: COVER_LABEL[k] ?? k,
    value: cases.filter((c) => c.status === k).length,
    color: COVER_FILL[k] ?? '#ccc',
  }));
  const tiles = metricTiles(src, findings)
    .map((m) => `<div class="tile"><div class="tv">${esc(m.value)}</div><div class="tl">${esc(m.label)}</div><div class="ts">${esc(m.sub)}</div></div>`)
    .join('');
  return `<section class="dash" aria-label="Summary at a glance">
<div class="tiles">${tiles}</div>
<div class="charts">
<figure class="chart"><figcaption>Findings by severity</figcaption><div class="chart-body">${donutSvg(sevSegs, fmt(findings.length), 'released')}${legendHtml(sevSegs)}</div></figure>
<figure class="chart"><figcaption>Test coverage${cases.length === 0 ? '' : ` · ${cases.length} planned`}</figcaption><div class="chart-body col">${stackedBar(covSegs)}${legendHtml(covSegs)}</div></figure>
</div>
</section>`;
}

const STYLE = `<style>
:root{color-scheme:light;--fg:#17150f;--muted:#625d52;--faint:#8c8678;--line:#ece9e2;--line2:#d9d4c9;--code:#f7f5f0;--panel:#fbfaf7;--gold:#e2b23a;--gold-ink:#8a6310;--gold-soft:#fbf4e2;--ok:#1b7a3e;--crit:#6e1520;--high:#c0392b;--med:#c2740a;--low:#6b7280}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#f1efe9;color:var(--fg);font:15px/1.62 "Poppins",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.sheet{max-width:900px;margin:0 auto;background:#fff;box-shadow:0 1px 40px rgba(20,18,12,.08)}
main{padding:0 44px 52px}
.cover{position:relative;overflow:hidden;background:linear-gradient(135deg,#1c1a14 0%,#2a2619 55%,#3a3320 100%);color:#f5f1e6;padding:40px 44px 32px}
.cover::after{content:"";position:absolute;right:-70px;top:-70px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,rgba(226,178,58,.32),transparent 70%)}
.cover .brand{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--gold)}
.cover .brand i{display:inline-block;width:13px;height:13px;border-radius:4px;background:var(--gold);box-shadow:0 0 0 4px rgba(226,178,58,.18)}
.badge{position:absolute;top:40px;right:44px;border:1px solid rgba(245,241,230,.35);border-radius:999px;padding:4px 13px;font-size:10.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#f5f1e6}
.cover h1{font-size:33px;line-height:1.15;margin:24px 0 10px;letter-spacing:-.02em;font-weight:700}
.cover .target{font-size:18px;font-weight:600;margin:0;color:#fff}
.cover .sub{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:rgba(245,241,230,.72);margin:4px 0 0}
.cmeta{display:flex;flex-wrap:wrap;gap:14px 30px;margin-top:26px;padding-top:20px;border-top:1px solid rgba(245,241,230,.18)}
.cmeta .k{color:rgba(245,241,230,.6);text-transform:uppercase;letter-spacing:.08em;font-size:10px;margin-bottom:3px}
.cmeta .v{color:#fff;font-weight:600;font-size:13px}
.lede{font-size:17px;line-height:1.5;margin:28px 0 6px}
.dash{margin:22px 0 6px}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.tile{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--panel)}
.tile .tv{font-size:24px;font-weight:700;letter-spacing:-.01em;line-height:1.1}
.tile .tl{font-size:12.5px;font-weight:600;margin-top:4px}
.tile .ts{font-size:11.5px;color:var(--muted);margin-top:1px}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
.chart{margin:0;border:1px solid var(--line);border-radius:12px;padding:15px 18px;background:#fff}
.chart figcaption{font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin-bottom:12px}
.chart-body{display:flex;align-items:center;gap:18px}
.chart-body.col{flex-direction:column;align-items:stretch;gap:12px}
.bar{width:100%;height:12px;border-radius:6px;overflow:hidden;background:var(--line)}
.bar svg{display:block;width:100%;height:12px}
.legend{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;font-size:12.5px;min-width:0;flex:1}
.legend li{display:flex;align-items:center;gap:8px}
.legend .sw{width:10px;height:10px;border-radius:3px;flex:none}
.legend b{margin-left:auto;font-variant-numeric:tabular-nums}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;padding:0;list-style:none}
.chip{display:inline-block;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:600}
h2{font-size:17px;margin:40px 0 14px;padding-bottom:9px;border-bottom:2px solid var(--line);position:relative;letter-spacing:-.01em}
h2::before{content:"";position:absolute;left:0;bottom:-2px;width:46px;height:2px;background:var(--gold)}
h2 .meta{font-weight:400}
dl{display:grid;grid-template-columns:180px minmax(0,1fr);gap:9px 18px;margin:0;font-size:14px}
dt{color:var(--muted)}dd{margin:0}
article{border:1px solid var(--line);border-left:4px solid var(--line2);border-radius:12px;padding:18px 22px 20px;margin:14px 0;break-inside:avoid;background:#fff}
article.sev-critical{border-left-color:var(--crit)}
article.sev-high{border-left-color:var(--high)}
article.sev-medium{border-left-color:var(--med)}
article.sev-low{border-left-color:var(--low)}
article.sev-info{border-left-color:var(--low)}
article h3{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:16.5px;margin:0 0 4px}
.meta{margin:0;color:var(--muted);font-size:13px}
h4{font-size:11px;letter-spacing:.07em;text-transform:uppercase;margin:18px 0 6px;color:var(--faint)}
h4 span{font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)}
.proof{color:var(--ok);font-weight:600;margin:0 0 6px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--code);font-weight:600;width:110px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
td code{word-break:break-all}
pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:12px;white-space:pre-wrap;word-break:break-all;margin:6px 0}
.ai{border:1px solid var(--line);border-left:3px solid var(--gold);border-radius:8px;padding:10px 14px;background:var(--gold-soft)}
.ai p{margin:6px 0}
ul.limits{padding-left:20px;color:var(--muted);font-size:14px}
ol.steps{margin:6px 0 10px;padding-left:22px}
ol.steps li{margin:4px 0;padding-left:4px}
ul.refs{margin:6px 0;padding-left:20px;font-size:13.5px}
ul.refs li{margin:3px 0}
a{color:var(--gold-ink);text-decoration:underline;text-underline-offset:2px}
footer{margin-top:44px;padding:18px 44px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;background:var(--panel)}
@media (max-width:640px){main{padding:0 20px 40px}.cover{padding:30px 20px}.badge{position:static;display:inline-block;margin-top:10px}.tiles{grid-template-columns:1fr 1fr}.charts{grid-template-columns:1fr}dl{grid-template-columns:1fr}dt{font-weight:600;color:var(--fg)}article{padding:16px}footer{padding:16px 20px}}
@media print{body{background:#fff}.sheet{max-width:none;box-shadow:none}main{padding:0 6px}.cover{border-radius:0}article,.dash,.chart,.tile{break-inside:avoid}h2{break-after:avoid}footer{background:#fff}}
</style>`;

function exposureHtml(intel: Intel | null): string {
  if (intel === null) return `<h2>External exposure</h2>\n<p class="meta">${esc(NO_INTEL)}</p>`;
  return `<h2>External exposure</h2>
<p class="meta">${esc(exposureIntro(intel))}</p>${intel.skipped === null ? '' : `\n<p class="meta">${esc(intel.skipped)}.</p>`}
<ul class="limits">${intel.sources.map((x) => `<li>${esc(x.name)}: ${esc(x.note)}</li>`).join('')}</ul>
${
  intel.items.length === 0
    ? '<p class="meta">No exposure items were found.</p>'
    : `<table>${intel.items
        .map(
          (i) =>
            `<tr><td><span class="chip" style="${SEV_STYLE[i.severity] ?? SEV_STYLE.info ?? ''}">${esc(cap(i.severity))}</span> <b>${esc(i.title)}</b><br><span class="meta">${esc(INTEL_BASIS[i.basis])}</span></td><td>${esc(i.detail)}</td></tr>`,
        )
        .join('')}</table>`
}${intel.discoveredHosts.length === 0 ? '' : `\n<p class="meta">Hosts discovered in public sources outside the approved scope (reported, not tested): ${esc(intel.discoveredHosts.join(', '))}</p>`}`;
}

/**
 * A representative CVSS v3.1 base score and vector for each qualitative severity. The runner records a severity, not a
 * measured vector, so this is derived from that rating and labelled as such in the report — never presented as a scored
 * analysis of the specific issue.
 */
const CVSS: Readonly<Record<string, { score: string; vector: string | null }>> = {
  critical: { score: '9.8', vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
  high: { score: '7.5', vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' },
  medium: { score: '5.3', vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N' },
  low: { score: '3.7', vector: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N' },
  info: { score: '0.0', vector: null },
};

/** The CWE/OWASP mapping table, with a link to the CWE definition when the id is well-formed. */
function mappingHtml(f: FindingDetail): string {
  const rows: string[] = [];
  const cweNum = /^CWE-(\d+)$/i.exec(f.cwe ?? '');
  if (f.cwe !== null && f.cwe !== '')
    rows.push(
      `<tr><th>CWE</th><td>${
        cweNum === null
          ? esc(f.cwe)
          : `<a href="https://cwe.mitre.org/data/definitions/${cweNum[1]}.html">${esc(f.cwe)}</a>`
      }</td></tr>`,
    );
  if (f.owasp !== null && f.owasp !== '')
    rows.push(`<tr><th>OWASP</th><td>${esc(f.owasp)}</td></tr>`);
  if (rows.length === 0) return '<p class="meta">No weakness mapping was recorded.</p>';
  return `<table>${rows.join('')}</table>`;
}

/** External references for the finding: the CWE definition and the OWASP Top 10 category. */
function referencesHtml(f: FindingDetail): string {
  const refs: string[] = [];
  const cweNum = /^CWE-(\d+)$/i.exec(f.cwe ?? '');
  if (cweNum !== null)
    refs.push(
      `<li><a href="https://cwe.mitre.org/data/definitions/${cweNum[1]}.html">${esc(f.cwe ?? '')}: MITRE CWE definition</a></li>`,
    );
  if (f.owasp !== null && f.owasp !== '')
    refs.push(`<li><a href="https://owasp.org/Top10/">OWASP Top 10 — ${esc(f.owasp)}</a></li>`);
  if (refs.length === 0) return '';
  return `<h4>References</h4>\n<ul class="refs">${refs.join('')}</ul>`;
}

export function renderHtml(
  src: ReportSource,
  findings: readonly FindingDetail[],
  generatedAt: string,
  images?: ShotImages,
): string {
  const issues = findings
    .map((f, i) => {
      const proof = proofOf(f);
      const check = oracleWords(f.oracle);
      const remediation = f.evidence.remediation?.trim() ?? '';
      const excerpt = f.evidence.probe.response?.bodyExcerpt ?? '';
      const released = releaseLine(f);
      const cvss = CVSS[f.severity] ?? CVSS.info ?? { score: '—', vector: null };
      const overview =
        f.description !== null && f.description.trim() !== ''
          ? `<div class="ai">${markdownToHtml(f.description.trim())}</div>`
          : `<p>${esc(`A ${f.severity}-severity issue was proven on this target.`)}</p>`;
      const steps = [
        `<li>Send the probe request <code>${esc(sideWords(f.evidence.probe))}</code>${f.reproCurl === '' ? '.' : ' (full command below).'}</li>`,
        check === null
          ? '<li>Observe that the response shows the issue, as proven below.</li>'
          : `<li>Observe that ${esc(check)}.</li>`,
        `<li>${esc(replaySummary(f))} Blackwing replayed this deterministically to confirm it was not a one-off.</li>`,
      ].join('');
      return `<article class="sev-${esc(f.severity)}">
<h3><span class="chip" style="${SEV_STYLE[f.severity] ?? SEV_STYLE.info ?? ''}">${esc(cap(f.severity))}</span>${i + 1}. ${esc(f.title)}</h3>
<p class="meta">${esc(meta(f))}</p>${released === null ? '' : `\n<p class="meta">${esc(released)}</p>`}
<h4>Overview${f.description === null || f.description.trim() === '' ? '' : ' <span>· Blackwing AI’s explanation, not verified</span>'}</h4>
${overview}
<h4>CVSS v3.1 <span>· representative, derived from the assessed severity</span></h4>
<table>
<tr><th>Base score</th><td><b>${esc(cvss.score)}</b> (${esc(cap(f.severity))})</td></tr>${
        cvss.vector === null ? '' : `\n<tr><th>Vector</th><td><code>${esc(cvss.vector)}</code></td></tr>`
      }
</table>
<h4>Weakness mapping</h4>
${mappingHtml(f)}
<h4>Affected location</h4>
<p><code>${esc(sideWords(f.evidence.probe))}</code></p>
<h4>Steps to reproduce</h4>
<ol class="steps">${steps}</ol>${f.reproCurl === '' ? '' : `\n<pre>${esc(f.reproCurl)}</pre>\n<p class="meta">Run it only against a copy you own.</p>`}
<h4>Evidence &amp; verification <span>· ${esc(PROOF_BY)}</span></h4>
<p class="${proof.proven ? 'proof' : 'meta'}">${esc(proof.text)}</p>${check === null ? '' : `\n<p class="meta">${esc(checkedLine(f, check))}</p>`}
<table>
<tr><th>Probe</th><td><code>${esc(sideWords(f.evidence.probe))}</code><br><span class="meta">The request that shows the issue.</span></td></tr>
<tr><th>Control</th><td><code>${esc(sideWords(f.evidence.control))}</code><br><span class="meta">${esc(cap(controlNote(f)))}.</span></td></tr>
</table>${shotsHtml(f, images)}${excerpt === '' ? '' : `\n<p class="meta">What the site answered to the probe (excerpt):</p>\n<pre>${esc(excerpt)}</pre>`}${controlExcerpt(f) === '' ? '' : `\n<p class="meta">What the site answered to the control (excerpt):</p>\n<pre>${esc(controlExcerpt(f))}</pre>`}${
        replayRows(f).length === 0
          ? ''
          : `\n<table><tr><th>Replay</th><th>HTTP status</th><th>Expected result shown</th></tr>${replayRows(f)
              .map((r) => `<tr><td>${r.n}</td><td>${r.status}</td><td>${r.matched ? 'yes' : 'no'}</td></tr>`)
              .join('')}</table>`
      }
<h4>Remediation${remediation === '' ? '' : ' <span>· Blackwing AI’s suggestion, not verified</span>'}</h4>
${remediation === '' ? '<p class="meta">No remediation guidance was recorded for this issue.</p>' : `<div class="ai">${markdownToHtml(remediation)}</div>`}
${referencesHtml(f)}
</article>`;
    })
    .join('\n');
  const gaps = notTestedOf(src);
  const gapsHtml = [
    gaps.recorded ? '' : `<p class="meta">${esc(NOT_RECORDED)}</p>`,
    gaps.rows.length > 0
      ? `<dl>${gaps.rows.map((r) => `<dt>${esc(r.what)}</dt><dd>${esc(r.why)}</dd>`).join('\n')}</dl>`
      : gaps.recorded
        ? `<p class="meta">${esc(NO_GAPS)}</p>`
        : '',
    gaps.note === null
      ? ''
      : `<h4>Blackwing AI’s own note <span>· not verified</span></h4>\n<div class="ai">${markdownToHtml(gaps.note)}</div>`,
  ]
    .filter((x) => x !== '')
    .join('\n');
  const kept = [...src.keptBack].sort(bySeverity);
  const keptHtml =
    kept.length === 0
      ? '<p class="meta">No suspected issues were kept back in this audit.</p>'
      : `<p class="meta"><b>Not proven.</b> These issues were suspected but the validator could not prove them. They were not released and are not findings of this report.</p>\n${kept
          .map(
            (f, i) => `<article>
<h3><span class="chip" style="background:#f0f1f3;color:#4b5160">Not proven</span>K${i + 1}. ${esc(f.title)}</h3>
<p class="meta">${esc(`${cap(f.severity)} (proposed) · ${meta(f)}`)}</p>
<p class="meta">Why it is not proven: ${esc(keptReason(f))}.</p>
<table>
<tr><th>Probe</th><td><code>${esc(sideWords(f.evidence.probe))}</code></td></tr>
<tr><th>Control</th><td><code>${esc(sideWords(f.evidence.control))}</code></td></tr>
</table>${f.description === null || f.description.trim() === '' ? '' : `\n<div class="ai">${markdownToHtml(f.description.trim())}</div>`}
</article>`,
          )
          .join('\n')}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title(src))} · Blackwing report</title>
${STYLE}</head>
<body><div class="sheet">
<header class="cover">
<div class="brand"><i></i>Blackwing · Security Assessment</div>
<span class="badge">Confidential</span>
<h1>${esc(title(src))}</h1>
<p class="target">${esc(src.asset.name)}</p>
<p class="sub">${esc(src.asset.baseUrl)}</p>
<div class="cmeta">
<div><div class="k">Report ID</div><div class="v">${esc(src.run.id.slice(0, 8).toUpperCase())}</div></div>
<div><div class="k">Assessment date</div><div class="v">${esc(when(src.run.startedAt) ?? '—')}</div></div>
<div><div class="k">Authorised by</div><div class="v">${esc(src.request.approver?.name ?? 'An administrator')}</div></div>
<div><div class="k">Prepared by</div><div class="v">Blackwing</div></div>
</div>
</header>
<main>
<p class="lede">${esc(reportLede(findings))}</p>
${dashboard(src, findings)}
${summaryBody(src) === null ? '' : `<h2>Executive summary <span class="meta">· ${esc(SUMMARY_TAG)}</span></h2>\n<div class="ai">${markdownToHtml(summaryBody(src) ?? '')}</div>\n`}
<h2>About this audit</h2>
<dl>
${facts(src)
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
  .join('\n')}
</dl>
${findings.length === 0 ? '' : `<h2>Issues, most severe first</h2>\n${issues}`}
${exposureHtml(src.externalExposure)}
<h2>What was not tested and why</h2>
${gapsHtml}
<h2>Limits of this report</h2>
<ul class="limits">${LIMITS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<h2>Appendix: kept-back findings (not proven)</h2>
${keptHtml}
</main>
<footer>Generated by Blackwing on ${esc(when(generatedAt) ?? generatedAt)}. Every decision behind it is sealed in the workspace ledger.</footer>
</div></body></html>
`;
}

/** Fields that only mean something inside Blackwing (storage ids, hashes of bodies, queue and kill bookkeeping, other audits' ids). */
const INTERNAL_KEYS: ReadonlySet<string> = new Set([
  'assetId',
  'requestId',
  'exchangeId',
  'identityKey',
  'bodySha256',
  'killRequestedAt',
  'haltMs',
  'queue',
  'pins',
  'seenBefore',
]);

/** Removes INTERNAL_KEYS at any depth, so a report handed to a client carries no internal bookkeeping. */
function dropInternal(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => dropInternal(v));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !INTERNAL_KEYS.has(k))
      .map(([k, v]) => [k, dropInternal(v)]),
  );
}

/** The machine-readable report: the API's JSON without the agent's run summary, and the findings most severe first. */
export function renderJson(
  raw: Readonly<Record<string, unknown>>,
  findings: readonly FindingDetail[],
): string {
  const run =
    typeof raw.run === 'object' && raw.run !== null
      ? { ...(raw.run as Record<string, unknown>) }
      : {};
  delete run.summary;
  const order = new Map(findings.map((f, i) => [f.id, i]));
  const list = Array.isArray(raw.findings) ? [...(raw.findings as unknown[])] : [];
  const idOf = (x: unknown): string =>
    typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string'
      ? (x as { id: string }).id
      : '';
  list.sort((a, b) => (order.get(idOf(a)) ?? 0) - (order.get(idOf(b)) ?? 0));
  // One scope: the paths the run was pinned to leave out are the asset's excluded paths too.
  const obj = (x: unknown): Record<string, unknown> =>
    typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {};
  const pinned = obj(obj(run.pins).asset).excludedPaths;
  const asset = { ...obj(raw.asset) };
  if (Array.isArray(pinned) && pinned.length > 0 && !(Array.isArray(asset.excludedPaths) && asset.excludedPaths.length > 0))
    asset.excludedPaths = pinned;
  // An empty list here means nothing was released, not that nothing was found.
  const keptBack = Array.isArray(raw.keptBack) ? (raw.keptBack as unknown[]) : [];
  const scope = {
    releasedFindingsOnly: true,
    releasedCount: list.length,
    keptBackCount: keptBack.length,
    keptBackNote: 'keptBack lists suspected issues the validator could not prove. They are NOT proven and not released.',
  };
  // "What was not tested and why", as in the HTML and Markdown reports.
  const parsed = reportSourceSchema.safeParse(raw);
  const gaps = parsed.success ? notTestedOf(parsed.data) : null;
  const notTestedSection = gaps === null ? null : { recorded: gaps.recorded, items: gaps.rows, note: gaps.note };
  // The vendor name of the model never appears in a customer file: it is Blackwing AI.
  return JSON.stringify(
    dropInternal(scrubDeep({ ...raw, asset, run, scope, findings: list, keptBack, notTested: notTestedSection })),
    null,
    2,
  ).replace(/"proposedBy": "claude"/g, '"proposedBy": "blackwing-ai"');
}

/** Released findings, most severe first (the order of the results page). */
export const ordered = (src: ReportSource): FindingDetail[] => [...src.findings].sort(bySeverity);
