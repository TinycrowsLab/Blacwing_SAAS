// DEMO-STORY report renderer: one finding as a standalone HTML page or as Markdown. Pure functions, no IO.
// Every value from the target (bodies, headers) is escaped before it reaches HTML (it is untrusted).
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

/** Text from an untyped JSON field, or the fallback. */
const textOf = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

/** Length of the finding id prefix used in the download file name. */
const ID_PREFIX_LENGTH = 8;

const esc = (value: unknown): string =>
  (typeof value === 'string' ? value : (JSON.stringify(value) as string | undefined) ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

interface EvidenceView {
  readonly probe?: { request?: { url?: string }; response?: { status?: number; bodyExcerpt?: string } };
  readonly negativeControl?: { request?: { url?: string }; response?: { status?: number; bodyExcerpt?: string } };
  readonly recorded?: boolean;
}

function lines(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split('\n');
}

export function renderReport(input: ReportInput, format: ReportFormat): RenderedReport {
  const { finding, run, asset, request } = input;
  const evidence = finding.evidence as EvidenceView;
  const replay = finding.replay as { replays?: { n: number; status: number; matched: boolean }[] };
  const severity = finding.severity as { cvssV4Vector?: string; cvssV4Score?: number };
  const pins = run.pins as { testCase?: { wstg?: string } };
  const scope = request.scope;
  const stamp = finding.created_at.toISOString();
  const base = `finding-${finding.id.slice(0, ID_PREFIX_LENGTH)}`;
  if (format === 'md') {
    const replayRows = (replay.replays ?? [])
      .map((r) => `| ${r.n} | ${r.status} | ${r.matched ? 'yes' : 'no'} |`)
      .join('\n');
    const body = [
      `# ${finding.title}`,
      '',
      `Status: **${finding.status}** (validated by deterministic replay, demo runner)  `,
      `Severity: CVSS v4.0 ${severity.cvssV4Score ?? 'n/a'} (\`${severity.cvssV4Vector ?? 'n/a'}\`), demo-assigned`,
      `CWE: ${finding.cwe_id}  OWASP: ${finding.owasp_category}  WSTG: ${pins.testCase?.wstg ?? 'n/a'}`,
      `Asset: ${asset.name} (${asset.base_url}), ownership ${asset.ownership_status} (lab trust)`,
      `Run: ${run.id} (state ${run.state}, requests used ${run.requests_used} of ${run.budget_requests})`,
      `Gate 1: approved by ${request.approver_id ?? 'n/a'}, requested by ${request.requester_id}`,
      `Generated: ${stamp}`,
      '',
      '## Summary',
      '',
      `The product search parameter \`${textOf(finding.location.parameter, 'q')}\` on \`${textOf(finding.location.urlTemplate, '')}\` ` +
        'returns a database error when a single quote is supplied. The oracle matched the error signature ' +
        `\`${textOf((finding.oracle.params as { signature?: unknown }).signature, '')}\` on both replays, and did not match on the negative control.`,
      '',
      '## Reproduction',
      '',
      'Detection probe (benign, one syntax-breaking quote, no data extraction):',
      '',
      '```sh',
      finding.repro_curl,
      '```',
      '',
      '## Replay results',
      '',
      '| Replay | HTTP status | Oracle matched |',
      '|---|---|---|',
      replayRows,
      '',
      '## Evidence',
      '',
      `Probe URL: ${evidence.probe?.request?.url ?? 'n/a'}  `,
      `Probe status: ${evidence.probe?.response?.status ?? 'n/a'}`,
      '',
      '```',
      evidence.probe?.response?.bodyExcerpt ?? '',
      '```',
      '',
      `Negative control URL: ${evidence.negativeControl?.request?.url ?? 'n/a'}  `,
      `Negative control status: ${evidence.negativeControl?.response?.status ?? 'n/a'} (oracle not matched)`,
      '',
      evidence.recorded === true
        ? '_Note: this finding is the recorded fallback from an earlier run, shown when no live run has completed._'
        : '',
      '',
      '## Scope and pins',
      '',
      '```json',
      ...lines({ scope, pins: run.pins }),
      '```',
      '',
      '## Limitations',
      '',
      '- Lab target only (local Juice Shop). Detection only: no data was extracted.',
      '- Severity is demo-assigned for the story, not computed by a CVSS calculator.',
      '- Demo stubs: planner, specialist, egress and sandbox are not the production components (see the demo runbook).',
      '',
    ].join('\n');
    return { contentType: 'text/markdown; charset=utf-8', filename: `${base}.md`, body };
  }

  const replayRows = (replay.replays ?? [])
    .map(
      (r) =>
        `<tr><td>${esc(r.n)}</td><td>${esc(r.status)}</td><td>${r.matched ? 'yes' : 'no'}</td></tr>`,
    )
    .join('');
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(finding.title)} | Blackwing demo report</title>
<style>
:root{color-scheme:light dark;--fg:#1c1c1e;--muted:#5b5b63;--bg:#fff;--line:#d6d6dc;--code:#f4f4f7;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--fg:#ececf1;--muted:#a3a3ad;--bg:#16161a;--line:#33333b;--code:#22222a;--warn:#e6b35c}}
body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);margin:0;padding:24px 16px}
main{max-width:920px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.meta{color:var(--muted);font-size:13px}table{width:100%;border-collapse:collapse;font-size:14px}
td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
pre,code{background:var(--code);border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
pre{padding:10px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:12px;margin-right:6px}
.warn{color:var(--warn)}
</style></head>
<body><main>
<h1>${esc(finding.title)}</h1>
<p class="meta">Blackwing demo report. Generated ${esc(stamp)}. Lab target only.</p>
<p><span class="badge">${esc(finding.status)}</span><span class="badge">${esc(finding.cwe_id)}</span><span class="badge">${esc(finding.owasp_category)}</span><span class="badge">CVSS v4.0 ${esc(severity.cvssV4Score ?? 'n/a')} (demo-assigned)</span></p>
<table>
<tr><th>Asset</th><td>${esc(asset.name)} (${esc(asset.base_url)}), ownership ${esc(asset.ownership_status)} by lab trust</td></tr>
<tr><th>Run</th><td>${esc(run.id)}, state ${esc(run.state)}, requests ${esc(run.requests_used)} of ${esc(run.budget_requests)}</td></tr>
<tr><th>Gate 1</th><td>Requested by ${esc(request.requester_id)}, approved by ${esc(request.approver_id ?? 'n/a')}</td></tr>
<tr><th>Location</th><td><code>${esc(finding.location.method ?? '')} ${esc(finding.location.urlTemplate ?? '')}</code>, parameter <code>${esc(finding.location.parameter ?? '')}</code></td></tr>
</table>
<h2>Summary</h2>
<p>The product search parameter returns a database error when a single quote is supplied. The oracle matched the error signature on every replay and did not match on the negative control.</p>
<h2>Reproduction</h2>
<p>Detection probe (benign, one syntax-breaking quote, no data extraction):</p>
<pre><code>${esc(finding.repro_curl)}</code></pre>
<h2>Replay results</h2>
<table><tr><th>Replay</th><th>HTTP status</th><th>Oracle matched</th></tr>${replayRows}</table>
<h2>Evidence</h2>
<p>Probe status ${esc(evidence.probe?.response?.status ?? 'n/a')}, <code>${esc(evidence.probe?.request?.url ?? '')}</code></p>
<pre>${esc(evidence.probe?.response?.bodyExcerpt ?? '')}</pre>
<p>Negative control status ${esc(evidence.negativeControl?.response?.status ?? 'n/a')}, <code>${esc(evidence.negativeControl?.request?.url ?? '')}</code> (oracle not matched)</p>
${evidence.recorded === true ? '<p class="warn">Recorded fallback from an earlier run, shown when no live run has completed.</p>' : ''}
<h2>Scope and pins</h2>
<pre><code>${esc(JSON.stringify({ scope, pins: run.pins }, null, 2))}</code></pre>
<h2>Limitations</h2>
<ul>
<li>Lab target only (local Juice Shop). Detection only: no data was extracted.</li>
<li>Severity is demo-assigned for the story, not computed by a CVSS calculator.</li>
<li>Demo stubs: planner, specialist, egress and sandbox are not the production components (see the demo runbook).</li>
</ul>
</main></body></html>
`;
  return { contentType: 'text/html; charset=utf-8', filename: `${base}.html`, body };
}
