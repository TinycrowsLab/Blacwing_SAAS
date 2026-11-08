// DEMO-STORY report renderer: one finding, or one run's released findings, as a standalone HTML page, Markdown,
// JSON or SARIF. Pure functions, no IO.
// Every value from the target (bodies, headers) is escaped before it reaches HTML (it is untrusted), and every
// finding and summary is scrubbed of secrets first (rows stored before store-time scrubbing too).
import { z } from 'zod';

import { scrub, scrubDeep } from '@blackwing/errors/scrub';

import { assetDto, findingDto, owaspLabel, requestDto, runDto, scrubFinding, shortId } from './service.js';

import type { AssetRow, FindingRow, RequestRow, RunRow } from './store.js';

export const REPORT_FORMATS = ['html', 'md'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
export const RUN_REPORT_FORMATS = ['html', 'md', 'json', 'sarif'] as const;
export type RunReportFormat = (typeof RUN_REPORT_FORMATS)[number];

export interface RunReportInput {
  readonly run: RunRow;
  readonly asset: AssetRow;
  readonly request: RequestRow;
  /** Released findings only. */
  readonly findings: readonly FindingRow[];
  /** The run's last `coverage.summary` data (null for old or unfinished runs). */
  readonly coverage?: Record<string, unknown> | null;
  /** How the run ended (`run.completed|failed|killed` event data), null while it runs. */
  readonly endReason?: string | null;
  /** The console's origin: SARIF `informationUri`. */
  readonly consoleOrigin?: string;
}

export interface ReportInput {
  readonly finding: FindingRow;
  readonly run: RunRow;
  readonly asset: AssetRow;
  readonly request: RequestRow;
}

export interface RenderedReport {
  readonly contentType: string;
  readonly filename: string;
  readonly body: string;
}

const exchange = z.object({
  request: z.object({ method: z.string(), url: z.string(), body: z.string().nullish() }).partial().optional(),
  response: z.object({ status: z.number(), bodyExcerpt: z.string() }).partial().optional(),
});

/** The evidence shape the worker writes; every part is optional so older rows still render. */
const evidenceSchema = z.object({
  probe: exchange.optional(),
  control: exchange.optional(),
  oracle: z.object({ type: z.string(), value: z.string() }).optional(),
  replays: z.array(z.object({ n: z.number(), status: z.number(), matched: z.boolean() })).default([]),
  /** Set only when the validator rejected the candidate; it is reportable only because an analyst released it by hand. */
  reason: z.string().optional(),
});
type Evidence = z.infer<typeof evidenceSchema>;
type Exchange = z.infer<typeof exchange>;

const ID_PREFIX_LENGTH = 8;

const esc = (value: string | number): string =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function severityOf(value: unknown): string {
  if (typeof value === 'string') return value;
  const level = (value as { level?: unknown } | null)?.level;
  return typeof level === 'string' ? level : 'info';
}

const requestLine = (e: Exchange | undefined): string =>
  `${e?.request?.method ?? 'GET'} ${e?.request?.url ?? 'n/a'}`;
const statusOf = (e: Exchange | undefined): string => String(e?.response?.status ?? 'n/a');
const oracleLine = (ev: Evidence): string => (ev.oracle ? `${ev.oracle.type}: ${ev.oracle.value}` : 'n/a');
const validationLine = (ev: Evidence): string =>
  ev.reason === undefined
    ? 'Validated by deterministic replay and a negative control.'
    : `Not validated: the validator rejected it (${ev.reason}) and an AppSec engineer released it by hand.`;
const controlOf = (ev: Evidence): Exchange | undefined => (ev.reason === undefined ? ev.control : undefined);

const LIMITATIONS = [
  'Proof of concept: severity is the model-proposed label, not a computed CVSS score.',
  'The description is written by the agent and is not verified. The replays, oracle and negative control are.',
  'Detection only: probes are the minimum needed to prove the issue.',
];

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const SARIF_LEVEL: Record<string, string> = { critical: 'error', high: 'error', medium: 'warning' };
/** GitHub code scanning's `security-severity` per level (critical..info). */
const SECURITY_SEVERITY: Record<string, string> = { critical: '9.5', high: '8.0', medium: '5.5', low: '3.0', info: '0.0' };
const severityRank = (level: string): number => {
  const index = (SEVERITIES as readonly string[]).indexOf(level);
  return index < 0 ? SEVERITIES.length : index;
};

/** One SARIF rule per CWE: its first finding's title, the CWE page, the OWASP tag and the highest severity seen. */
function sarifRules(findings: readonly FindingRow[]): Record<string, unknown>[] {
  return [...new Set(findings.map((f) => f.cwe_id))].map((id) => {
    const same = findings.filter((f) => f.cwe_id === id);
    const top = [...same].sort((a, b) => severityRank(severityOf(a.severity)) - severityRank(severityOf(b.severity)))[0];
    const number = /(\d+)/.exec(id)?.[1];
    return {
      id,
      name: id,
      shortDescription: { text: same[0]?.title ?? id },
      ...(number === undefined ? {} : { helpUri: `https://cwe.mitre.org/data/definitions/${number}.html` }),
      properties: {
        tags: [owaspLabel(same[0]?.owasp_category ?? ''), 'security'].filter((t) => t !== ''),
        'security-severity': SECURITY_SEVERITY[top === undefined ? 'info' : severityOf(top.severity)] ?? '0.0',
      },
    };
  });
}

/** A location relative to the target's base (`TARGET`), or the absolute URL when it is on another origin. */
function sarifLocation(url: string, base: string): Record<string, unknown> {
  try {
    const parsed = new URL(url);
    if (parsed.origin === base) {
      return { artifactLocation: { uri: `${parsed.pathname.replace(/^\//, '')}${parsed.search}`, uriBaseId: 'TARGET' } };
    }
  } catch {
    // Not a URL: reported as stored.
  }
  return { artifactLocation: { uri: url } };
}

/** Description, oracle, reproduction, replays and evidence of one finding; `h` is the heading prefix. */
function findingMarkdown(finding: FindingRow, ev: Evidence, h: string): string[] {
  const replayRows = ev.replays.map((r) => `| ${r.n} | ${r.status} | ${r.matched ? 'yes' : 'no'} |`);
  return [
    `${h} Validation`,
    '',
    validationLine(ev),
    '',
    `${h} Description (agent-written, not verified)`,
    '',
    finding.description ?? 'No description recorded.',
    '',
    `${h} Oracle`,
    '',
    `\`${oracleLine(ev)}\``,
    '',
    `${h} Reproduction`,
    '',
    '```sh',
    finding.repro_curl,
    '```',
    '',
    `${h} Replay results`,
    '',
    '| Replay | HTTP status | Oracle matched |',
    '|---|---|---|',
    ...replayRows,
    '',
    `${h} Evidence`,
    '',
    `Probe: \`${requestLine(ev.probe)}\` returned ${statusOf(ev.probe)}`,
    '',
    '```',
    ev.probe?.response?.bodyExcerpt ?? '',
    '```',
    '',
    controlOf(ev) === undefined
      ? 'Negative control: none recorded'
      : `Negative control: \`${requestLine(ev.control)}\` returned ${statusOf(ev.control)} (oracle not matched)`,
    '',
  ];
}

/** The HTML twin of {@link findingMarkdown}; `h` is the heading tag. */
function findingHtml(finding: FindingRow, ev: Evidence, h: 'h2' | 'h3'): string {
  const replayRows = ev.replays
    .map((r) => `<tr><td>${r.n}</td><td>${r.status}</td><td>${r.matched ? 'yes' : 'no'}</td></tr>`)
    .join('');
  return `<${h}>Validation</${h}>
<p>${esc(validationLine(ev))}</p>
<${h}>Description (agent-written, not verified)</${h}>
<p>${esc(finding.description ?? 'No description recorded.')}</p>
<${h}>Oracle</${h}>
<p><code>${esc(oracleLine(ev))}</code></p>
<${h}>Reproduction</${h}>
<pre><code>${esc(finding.repro_curl)}</code></pre>
<${h}>Replay results</${h}>
<table><tr><th>Replay</th><th>HTTP status</th><th>Oracle matched</th></tr>${replayRows}</table>
<${h}>Evidence</${h}>
<p>Probe <code>${esc(requestLine(ev.probe))}</code> returned ${esc(statusOf(ev.probe))}</p>
<pre>${esc(ev.probe?.response?.bodyExcerpt ?? '')}</pre>
${
  controlOf(ev) === undefined
    ? '<p>Negative control: none recorded</p>'
    : `<p>Negative control <code>${esc(requestLine(ev.control))}</code> returned ${esc(statusOf(ev.control))} (oracle not matched)</p>`
}
`;
}

const evidenceOf = (finding: FindingRow): Evidence => evidenceSchema.catch({ replays: [] }).parse(finding.evidence);

const HTML_STYLE = `<style>
:root{color-scheme:light dark;--fg:#1c1c1e;--muted:#5b5b63;--bg:#fff;--line:#d6d6dc;--code:#f4f4f7}
@media (prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#a3a3ad;--bg:#16161a;--line:#33333b;--code:#22222a}}
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px 16px}
main{max-width:920px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
h3{font-size:15px;margin:20px 0 6px}
.meta{color:var(--muted);font-size:13px}table{width:100%;border-collapse:collapse;font-size:14px}
td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
pre,code{background:var(--code);border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:12px;margin-right:6px}
</style>`;

const htmlPage = (title: string, main: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | Blackwing report</title>
${HTML_STYLE}</head>
<body><main>
${main}</main></body></html>
`;

const limitationsHtml = `<h2>Limitations</h2>
<ul>${LIMITATIONS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
`;

export function renderReport(input: ReportInput, format: ReportFormat): RenderedReport {
  const { run, asset, request } = input;
  const finding = scrubFinding(input.finding);
  const ev = evidenceOf(finding);
  const severity = severityOf(finding.severity);
  const base = `finding-${finding.id.slice(0, ID_PREFIX_LENGTH)}`;
  const run_ = `${run.id} (state ${run.state}, requests ${run.requests_used} of ${run.budget_requests})`;
  const gate1 = `requested by ${request.requester_name ?? request.requester_id}, approved by ${request.approver_name ?? 'n/a'}`;

  if (format === 'md') {
    const body = [
      `# ${finding.title}`,
      '',
      `Status: **${finding.status}**  `,
      `Severity: ${severity}  CWE: ${finding.cwe_id}  OWASP: ${owaspLabel(finding.owasp_category)}  Agent: ${finding.agent ?? 'n/a'}  `,
      `Asset: ${asset.name} (${asset.base_url}), ownership ${asset.ownership_status}  `,
      `Run: ${run_}  `,
      `Gate 1: ${gate1}  `,
      `Generated: ${finding.created_at.toISOString()}`,
      '',
      ...findingMarkdown(finding, ev, '##'),
      '## Scope and pins',
      '',
      '```json',
      JSON.stringify(scrubDeep(run.pins), null, 2),
      '```',
      '',
      '## Limitations',
      '',
      ...LIMITATIONS.map((l) => `- ${l}`),
      '',
    ].join('\n');
    return { contentType: 'text/markdown; charset=utf-8', filename: `${base}.md`, body };
  }

  const body = htmlPage(
    finding.title,
    `<h1>${esc(finding.title)}</h1>
<p class="meta">Blackwing report. Generated ${esc(finding.created_at.toISOString())}.</p>
<p><span class="badge">${esc(finding.status)}</span><span class="badge">${esc(severity)}</span><span class="badge">${esc(finding.cwe_id)}</span><span class="badge">${esc(owaspLabel(finding.owasp_category))}</span></p>
<table>
<tr><th>Asset</th><td>${esc(asset.name)} (${esc(asset.base_url)}), ownership ${esc(asset.ownership_status)}</td></tr>
<tr><th>Run</th><td>${esc(run_)}</td></tr>
<tr><th>Gate 1</th><td>${esc(gate1)}</td></tr>
<tr><th>Agent</th><td>${esc(finding.agent ?? 'n/a')}</td></tr>
</table>
${findingHtml(finding, ev, 'h2')}<h2>Scope and pins</h2>
<pre><code>${esc(JSON.stringify(scrubDeep(run.pins), null, 2))}</code></pre>
${limitationsHtml}`,
  );
  return { contentType: 'text/html; charset=utf-8', filename: `${base}.html`, body };
}

/** One run: the released findings only, as HTML, Markdown, JSON or SARIF. */
export function renderRunReport(input: RunReportInput, format: RunReportFormat): RenderedReport {
  const { run, asset, request } = input;
  const findings = input.findings.map((f) => scrubFinding(f));
  const base = `run-${run.id.slice(0, ID_PREFIX_LENGTH)}`;
  const counts = Object.fromEntries(
    SEVERITIES.map((s) => [s, findings.filter((f) => severityOf(f.severity) === s).length]),
  );

  if (format === 'json') {
    // The verification token proves ownership of the asset; it does not belong in a shareable report.
    const assetInfo = { ...assetDto(asset), verification: undefined };
    const body = JSON.stringify(
      {
        run: { ...runDto(run), endReason: input.endReason ?? null },
        asset: assetInfo,
        request: requestDto(request),
        counts,
        coverage: input.coverage ?? null,
        findings: findings.map((f) => findingDto(f)),
      },
      null,
      2,
    );
    return { contentType: 'application/json', filename: `${base}.json`, body };
  }

  if (format === 'sarif') {
    const target = new URL(asset.base_url).origin;
    const results = findings.map((f) => ({
      ruleId: f.cwe_id,
      level: SARIF_LEVEL[severityOf(f.severity)] ?? 'note',
      message: { text: f.title },
      partialFingerprints: { 'blackwingIdentity/v1': f.identity_key ?? f.fingerprint },
      properties: { findingId: f.id },
      locations: f.location.url === undefined ? [] : [{ physicalLocation: sarifLocation(f.location.url, target) }],
    }));
    const runner = (run.pins as { runner?: { version?: unknown } }).runner;
    const driver = {
      name: 'Blackwing',
      ...(typeof runner?.version === 'string' ? { version: runner.version } : {}),
      ...(input.consoleOrigin === undefined ? {} : { informationUri: input.consoleOrigin }),
      rules: sarifRules(findings),
    };
    const body = JSON.stringify(
      {
        version: '2.1.0',
        $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
        runs: [{ tool: { driver }, originalUriBaseIds: { TARGET: { uri: `${target}/` } }, results }],
      },
      null,
      2,
    );
    return { contentType: 'application/sarif+json', filename: `${base}.sarif`, body };
  }

  const header: [string, string][] = [
    ['Asset', `${asset.name} (${asset.base_url}), ownership ${asset.ownership_status}`],
    ['Scope origins', asset.allowed_origins.join(', ')],
    ['Intrusiveness', request.intrusiveness],
    ['Gate 1', `requested by ${request.requester_name ?? request.requester_id}, approved by ${request.approver_name ?? 'n/a'}`],
    ['Run', `${run.id} (state ${run.state})`],
    ['Requests', `${run.requests_used} of ${run.budget_requests}`],
    ['Cost', `$${Number(run.cost_usd).toFixed(2)}`],
  ];
  const countsLine = SEVERITIES.map((s) => `${s} ${counts[s]}`).join(', ');
  const summary = run.summary === null ? 'No summary recorded.' : scrub(run.summary);
  const meta = (f: FindingRow): string =>
    `Severity: ${severityOf(f.severity)}  CWE: ${f.cwe_id}  OWASP: ${owaspLabel(f.owasp_category)}  Agent: ${f.agent ?? 'n/a'}`;
  const title = `Run ${shortId(run.id)} report`;

  if (format === 'md') {
    const body = [
      `# ${title}`,
      '',
      ...header.map(([k, v]) => `${k}: ${v}  `),
      '',
      `Released findings: ${findings.length} (${countsLine})`,
      '',
      '## Summary (agent-written, not verified)',
      '',
      summary,
      '',
      ...findings.flatMap((f) => [
        `## ${f.title}`,
        '',
        `${meta(f)}  `,
        '',
        ...findingMarkdown(f, evidenceOf(f), '###'),
      ]),
      '## Limitations',
      '',
      ...LIMITATIONS.map((l) => `- ${l}`),
      '',
    ].join('\n');
    return { contentType: 'text/markdown; charset=utf-8', filename: `${base}.md`, body };
  }

  const body = htmlPage(
    title,
    `<h1>${esc(title)}</h1>
<p class="meta">Blackwing report. Released findings only.</p>
<table>
${header.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('\n')}
</table>
<p>Released findings: ${findings.length} (${esc(countsLine)})</p>
<h2>Summary (agent-written, not verified)</h2>
<p>${esc(summary)}</p>
${findings
  .map(
    (f) => `<h2>${esc(f.title)}</h2>
<p class="meta">${esc(meta(f))}</p>
${findingHtml(f, evidenceOf(f), 'h3')}`,
  )
  .join('')}${limitationsHtml}`,
  );
  return { contentType: 'text/html; charset=utf-8', filename: `${base}.html`, body };
}
