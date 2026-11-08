/* eslint-disable @typescript-eslint/no-magic-numbers -- report layout values */
// The run report people download and send on (experience spec §7, §8). The API gives the run's released findings as
// JSON; this file words them the way the console does: the target's name, plain words for every setting, the issues
// most severe first, and the three voices kept apart (Blackwing's proof, Claude's explanation and Claude's fix, the
// last two marked "not verified"). It holds released issues only, so the agent's run summary (written about every
// suspected issue, dismissed and unreleased ones too) never goes in. Pure functions, no IO; all text is escaped.
import { z } from 'zod';

import { scrubDeep } from '@blackwing/errors/scrub';

import { agentName } from '../../../lib/agents';
import { coverageSchema } from '../../../lib/schemas';
import { escapeHtml as esc, markdownToHtml } from '../markdown';
import { identityOf, oracleWords, PROOF_BY, proofSentence, requestLine } from './issue-body';
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
        /** Only Claude's own "not covered" note is read from it, marked not verified; the rest never goes in. */
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
    /** What the runner recorded about coverage; null for runs from before it did. */
    coverage: coverageSchema.nullable().default(null),
  })
  .loose();
export type ReportSource = z.infer<typeof reportSourceSchema>;

export const REPORT_FORMATS = ['html', 'md', 'json', 'sarif'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

const LIMITS = [
  'Severity is the label Claude proposed, not a computed CVSS score.',
  'Explanations and fixes are written by Claude and are not verified. The proof (replays and control) is.',
  'Claude proposed each check and its control; Blackwing replayed them. A finding holds for the state the site was in then.',
  'Detection only: each probe is the least needed to show the issue.',
  'No browser is used, so DOM-based XSS is not tested.',
  'Tokens, cookies and passwords in the evidence are redacted by Blackwing.',
  'Only issues a person released are listed. Issues still awaiting release, kept back or dismissed are left out.',
];

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

const title = (src: ReportSource): string => `Security audit of ${src.asset.name}`;

/** "What was not tested and why": the runner's case record, the plan's exclusions, and the fixed limits. */
function notTestedOf(src: ReportSource): { rows: { what: string; why: string }[]; note: string | null; recorded: boolean } {
  const n = notTested({ coverage: src.coverage, endReason: src.run.endReason, excludedPaths: src.request.excludedPaths, summary: src.run.summary });
  return { rows: [...n.rows], note: n.note, recorded: n.recorded };
}

const NOT_RECORDED =
  'Blackwing did not record test-case coverage for this audit, so it cannot list the cases that did not run.';
const NO_GAPS = 'Every planned test case ran, and the plan left nothing out.';

export function renderMarkdown(src: ReportSource, findings: readonly FindingDetail[]): string {
  const out: string[] = [
    `# ${title(src)}`,
    '',
    `Blackwing report · ${src.asset.baseUrl}`,
    '',
    reportLede(findings),
    '',
  ];
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
        '### What it means (Claude’s explanation, not verified)',
        '',
        f.description.trim(),
        '',
      );
    if (remediation !== '')
      out.push('### How to fix it (Claude’s suggestion, not verified)', '', remediation, '');
  });
  const gaps = notTestedOf(src);
  out.push('## What was not tested and why', '');
  if (!gaps.recorded) out.push(NOT_RECORDED, '');
  if (gaps.rows.length > 0) out.push(...gaps.rows.map((r) => `- **${r.what}:** ${r.why}`), '');
  else if (gaps.recorded) out.push(NO_GAPS, '');
  if (gaps.note !== null) out.push('Claude’s own note (not verified):', '', ...gaps.note.split('\n').map((l) => `> ${l}`), '');
  out.push('## Limits of this report', '', ...LIMITS.map((l) => `- ${l}`), '');
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

const STYLE = `<style>
:root{color-scheme:light;--fg:#17150f;--muted:#625d52;--line:#ece9e2;--line2:#d9d4c9;--code:#fbfaf7;--gold:#e2b23a;--gold-ink:#8a6310;--gold-soft:#fbf4e2;--ok:#1b7a3e}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--fg);font:15px/1.6 "Poppins",system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 24px 64px}
.brand{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--gold-ink)}
.brand i{display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--gold)}
h1{font-size:28px;line-height:1.25;margin:10px 0 4px;letter-spacing:-.01em}
.sub{margin:0;color:var(--muted);font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.lede{font-size:17px;margin:24px 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px;padding:0;list-style:none}
.chip{display:inline-block;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:600}
h2{font-size:18px;margin:40px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line)}
dl{display:grid;grid-template-columns:170px minmax(0,1fr);gap:8px 16px;margin:0;font-size:14px}
dt{color:var(--muted)}dd{margin:0}
article{border:1px solid var(--line);border-radius:16px;padding:20px 22px;margin:16px 0;break-inside:avoid-page}
article h3{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:17px;margin:0 0 4px}
.meta{margin:0;color:var(--muted);font-size:13px}
h4{font-size:12px;letter-spacing:.06em;text-transform:uppercase;margin:20px 0 6px;color:var(--fg)}
h4 span{font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted)}
.proof{color:var(--ok);font-weight:600;margin:0 0 6px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--code);font-weight:600;width:110px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
td code{word-break:break-all}
pre{background:var(--code);border:1px solid var(--line);border-radius:10px;padding:12px;white-space:pre-wrap;word-break:break-all;margin:6px 0}
.claude{border:1px dashed var(--line2);border-radius:12px;padding:10px 14px;background:var(--code)}
.claude p{margin:6px 0}
ul.limits{padding-left:20px;color:var(--muted);font-size:14px}
footer{margin-top:40px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:600px){dl{grid-template-columns:1fr}dt{font-weight:600;color:var(--fg)}article{padding:16px}}
@media print{main{padding:0}article{border-color:#ccc}}
</style>`;

export function renderHtml(
  src: ReportSource,
  findings: readonly FindingDetail[],
  generatedAt: string,
): string {
  const counts = SEVERITIES.map(
    (s) => [s, findings.filter((f) => f.severity === s).length] as const,
  ).filter(([, n]) => n > 0);
  const issues = findings
    .map((f, i) => {
      const proof = proofOf(f);
      const check = oracleWords(f.oracle);
      const remediation = f.evidence.remediation?.trim() ?? '';
      const excerpt = f.evidence.probe.response?.bodyExcerpt ?? '';
      const released = releaseLine(f);
      return `<article>
<h3><span class="chip" style="${SEV_STYLE[f.severity] ?? SEV_STYLE.info ?? ''}">${esc(cap(f.severity))}</span>${i + 1}. ${esc(f.title)}</h3>
<p class="meta">${esc(meta(f))}</p>${released === null ? '' : `\n<p class="meta">${esc(released)}</p>`}
<h4>${esc(proof.heading)} <span>· ${esc(PROOF_BY)}</span></h4>
<p class="${proof.proven ? 'proof' : 'meta'}">${esc(proof.text)}</p>${check === null ? '' : `\n<p class="meta">${esc(checkedLine(f, check))}</p>`}
<table>
<tr><th>Probe</th><td><code>${esc(sideWords(f.evidence.probe))}</code><br><span class="meta">The request that shows the issue.</span></td></tr>
<tr><th>Control</th><td><code>${esc(sideWords(f.evidence.control))}</code><br><span class="meta">${esc(cap(controlNote(f)))}.</span></td></tr>
</table>${excerpt === '' ? '' : `\n<p class="meta">What the site answered to the probe (excerpt):</p>\n<pre>${esc(excerpt)}</pre>`}${f.reproCurl === '' ? '' : `\n<p class="meta">Reproduce it (run it only against a copy you own):</p>\n<pre>${esc(f.reproCurl)}</pre>`}${
        f.description === null || f.description.trim() === ''
          ? ''
          : `\n<h4>What it means <span>· Claude’s explanation, not verified</span></h4>\n<div class="claude">${markdownToHtml(f.description.trim())}</div>`
      }${remediation === '' ? '' : `\n<h4>How to fix it <span>· Claude’s suggestion, not verified</span></h4>\n<div>${markdownToHtml(remediation)}</div>`}
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
      : `<h4>Claude’s own note <span>· not verified</span></h4>\n<div class="claude">${markdownToHtml(gaps.note)}</div>`,
  ]
    .filter((x) => x !== '')
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title(src))} · Blackwing report</title>
${STYLE}</head>
<body><main>
<div class="brand"><i></i>Blackwing · Security audit report</div>
<h1>${esc(title(src))}</h1>
<p class="sub">${esc(src.asset.baseUrl)}</p>
<p class="lede">${esc(reportLede(findings))}</p>
${counts.length === 0 ? '' : `<ul class="chips">${counts.map(([s, n]) => `<li class="chip" style="${SEV_STYLE[s] ?? ''}">${n} ${esc(cap(s))}</li>`).join('')}</ul>`}
<h2>About this audit</h2>
<dl>
${facts(src)
  .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
  .join('\n')}
</dl>
${findings.length === 0 ? '' : `<h2>Issues, most severe first</h2>\n${issues}`}
<h2>What was not tested and why</h2>
${gapsHtml}
<h2>Limits of this report</h2>
<ul class="limits">${LIMITS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
<footer>Generated by Blackwing on ${esc(when(generatedAt) ?? generatedAt)}. Every decision behind it is sealed in the workspace ledger.</footer>
</main></body></html>
`;
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
  return JSON.stringify(scrubDeep({ ...raw, run, findings: list }), null, 2);
}

/** Released findings, most severe first (the order of the results page). */
export const ordered = (src: ReportSource): FindingDetail[] => [...src.findings].sort(bySeverity);
