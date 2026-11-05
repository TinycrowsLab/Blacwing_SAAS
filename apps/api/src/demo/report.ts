// DEMO-STORY report renderer: one finding as a standalone HTML page or as Markdown. Pure functions, no IO.
// Every value from the target (bodies, headers) is escaped before it reaches HTML (it is untrusted).
import { z } from 'zod';

import type { AssetRow, FindingRow, RequestRow, RunRow } from './store.js';

export const REPORT_FORMATS = ['html', 'md'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

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

const LIMITATIONS = [
  'Proof of concept: severity is the model-proposed label, not a computed CVSS score.',
  'The description is written by the agent and is not verified. The replays, oracle and negative control are.',
  'Detection only: probes are the minimum needed to prove the issue and no data was extracted.',
];

export function renderReport(input: ReportInput, format: ReportFormat): RenderedReport {
  const { finding, run, asset, request } = input;
  const ev = evidenceSchema.catch({ replays: [] }).parse(finding.evidence);
  const severity = severityOf(finding.severity);
  const base = `finding-${finding.id.slice(0, ID_PREFIX_LENGTH)}`;
  const description = finding.description ?? 'No description recorded.';
  const run_ = `${run.id} (state ${run.state}, requests ${run.requests_used} of ${run.budget_requests})`;
  const gate1 = `requested by ${request.requester_name ?? request.requester_id}, approved by ${request.approver_name ?? 'n/a'}`;

  if (format === 'md') {
    const replayRows = ev.replays.map((r) => `| ${r.n} | ${r.status} | ${r.matched ? 'yes' : 'no'} |`);
    const body = [
      `# ${finding.title}`,
      '',
      `Status: **${finding.status}** (validated by deterministic replay)  `,
      `Severity: ${severity}  CWE: ${finding.cwe_id}  OWASP: ${finding.owasp_category}  Agent: ${finding.agent ?? 'n/a'}  `,
      `Asset: ${asset.name} (${asset.base_url}), ownership ${asset.ownership_status}  `,
      `Run: ${run_}  `,
      `Gate 1: ${gate1}  `,
      `Generated: ${finding.created_at.toISOString()}`,
      '',
      '## Description (agent-written, not verified)',
      '',
      description,
      '',
      '## Oracle',
      '',
      `\`${oracleLine(ev)}\``,
      '',
      '## Reproduction',
      '',
      '```sh',
      finding.repro_curl,
      '```',
      '',
      '## Replay results',
      '',
      '| Replay | HTTP status | Oracle matched |',
      '|---|---|---|',
      ...replayRows,
      '',
      '## Evidence',
      '',
      `Probe: \`${requestLine(ev.probe)}\` returned ${statusOf(ev.probe)}`,
      '',
      '```',
      ev.probe?.response?.bodyExcerpt ?? '',
      '```',
      '',
      `Negative control: \`${requestLine(ev.control)}\` returned ${statusOf(ev.control)} (oracle not matched)`,
      '',
      '## Scope and pins',
      '',
      '```json',
      JSON.stringify(run.pins, null, 2),
      '```',
      '',
      '## Limitations',
      '',
      ...LIMITATIONS.map((l) => `- ${l}`),
      '',
    ].join('\n');
    return { contentType: 'text/markdown; charset=utf-8', filename: `${base}.md`, body };
  }

  const replayRows = ev.replays
    .map((r) => `<tr><td>${r.n}</td><td>${r.status}</td><td>${r.matched ? 'yes' : 'no'}</td></tr>`)
    .join('');
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(finding.title)} | Blackwing report</title>
<style>
:root{color-scheme:light dark;--fg:#1c1c1e;--muted:#5b5b63;--bg:#fff;--line:#d6d6dc;--code:#f4f4f7}
@media (prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#a3a3ad;--bg:#16161a;--line:#33333b;--code:#22222a}}
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px 16px}
main{max-width:920px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.meta{color:var(--muted);font-size:13px}table{width:100%;border-collapse:collapse;font-size:14px}
td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
pre,code{background:var(--code);border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:12px;margin-right:6px}
</style></head>
<body><main>
<h1>${esc(finding.title)}</h1>
<p class="meta">Blackwing report. Generated ${esc(finding.created_at.toISOString())}.</p>
<p><span class="badge">${esc(finding.status)}</span><span class="badge">${esc(severity)}</span><span class="badge">${esc(finding.cwe_id)}</span><span class="badge">${esc(finding.owasp_category)}</span></p>
<table>
<tr><th>Asset</th><td>${esc(asset.name)} (${esc(asset.base_url)}), ownership ${esc(asset.ownership_status)}</td></tr>
<tr><th>Run</th><td>${esc(run_)}</td></tr>
<tr><th>Gate 1</th><td>${esc(gate1)}</td></tr>
<tr><th>Agent</th><td>${esc(finding.agent ?? 'n/a')}</td></tr>
</table>
<h2>Description (agent-written, not verified)</h2>
<p>${esc(description)}</p>
<h2>Oracle</h2>
<p><code>${esc(oracleLine(ev))}</code></p>
<h2>Reproduction</h2>
<pre><code>${esc(finding.repro_curl)}</code></pre>
<h2>Replay results</h2>
<table><tr><th>Replay</th><th>HTTP status</th><th>Oracle matched</th></tr>${replayRows}</table>
<h2>Evidence</h2>
<p>Probe <code>${esc(requestLine(ev.probe))}</code> returned ${esc(statusOf(ev.probe))}</p>
<pre>${esc(ev.probe?.response?.bodyExcerpt ?? '')}</pre>
<p>Negative control <code>${esc(requestLine(ev.control))}</code> returned ${esc(statusOf(ev.control))} (oracle not matched)</p>
<h2>Scope and pins</h2>
<pre><code>${esc(JSON.stringify(run.pins, null, 2))}</code></pre>
<h2>Limitations</h2>
<ul>${LIMITATIONS.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
</main></body></html>
`;
  return { contentType: 'text/html; charset=utf-8', filename: `${base}.html`, body };
}
