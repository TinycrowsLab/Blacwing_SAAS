// Passive, external threat intelligence, run once before any active testing. It asks what the public web already says
// about the authorised target's own organisation and domain (certificate transparency, web archive, public code,
// DNS/e-mail posture, banner CVEs, domain-level breach exposure) and probes the target itself only for exposed
// version-control and configuration files, through the normal scope guard and request budget.
// Rules that hold here, by code and not by prompt:
//  - Public intel sources are reached only through `intelFetch`: https, an allow-list of API hosts, a timeout, a call cap.
//  - Hosts found outside the approved scope are reported as discovered and never tested.
//  - Organisation level only: nothing about an individual is kept (no e-mail addresses, no personal repositories).
//  - Secrets found in public snippets are redacted before they are stored, emitted or reported.
//  - Nothing here calls a model: the analysis is deterministic code.
import { resolveMx, resolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';

import { z } from 'zod';

import { newId } from '@blackwing/ids';

import { sendRequest, type HttpResult } from './http-tool.js';
import { checkScope } from './scope.js';
import { recordProven } from './tools.js';
import { buildFindingRow, validateCandidate, type Candidate } from './validator.js';
import { isDisallowedAddress } from '../../run/preflight/address-guard.js';

import type { HuntContext } from './context.js';

const MS_PER_S = 1000;
const FETCH_TIMEOUT_S = 8;
const FETCH_TIMEOUT_MS = FETCH_TIMEOUT_S * MS_PER_S;
const SLD_MIN_LABELS = 3;
const APEX_LABELS = 2;
const PATH_MAX_CHARS = 200;
const SHOWN_FEW = 5;
const SHOWN_BREACHES = 8;
const SHOWN_HOSTS = 15;
const SHOWN_ITEMS = 12;
const MAX_PHASE_S = 90;
const PHASE_SHARE = 0.2;
const MAX_CALLS = 40;
const MIN_CALLS = 8;
const CALL_SHARE = 0.25;
const PROBE_SHARE = 0.3;
const MAX_BODY_CHARS = 4_000_000;
const MAX_APEXES = 2;
const MAX_ORIGINS = 2;
const MAX_HOSTS = 60;
const MAX_ITEMS = 60;
const MAX_ARCHIVED_SHOWN = 20;
const MAX_CVES_PER_PRODUCT = 5;
const GITHUB_SNIPPETS = 20;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const NVD_HIGH = 7;
const NVD_CRITICAL = 9;
const NVD_MEDIUM = 4;

export const PRIVATE_SKIP_MESSAGE = 'Threat intel skipped: private address';

/** The only hosts the public intel code paths may reach. Anything else is refused before a request is made. */
export const INTEL_HOSTS: readonly string[] = ['crt.sh', 'web.archive.org', 'api.github.com', 'haveibeenpwned.com', 'services.nvd.nist.gov'];

export interface IntelConfig {
  /** GitHub code search needs a token; without one the source is skipped. */
  readonly githubToken: string | null;
  /** HIBP domain search needs a key; without one the source is skipped. */
  readonly hibpApiKey: string | null;
}

export interface IntelDeps {
  readonly resolveTxt: (name: string) => Promise<string[][]>;
  readonly resolveMx: (name: string) => Promise<{ exchange: string; priority: number }[]>;
}

const defaultDeps: IntelDeps = { resolveTxt, resolveMx };

export type IntelBasis = 'finding' | 'observed' | 'unverified';
export type IntelSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** One line of the "External exposure" section. `unverified` items are shown as "intel, not verified". */
export interface IntelItem {
  readonly source: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: IntelSeverity;
  readonly basis: IntelBasis;
  readonly findingId?: string | null;
}

export interface IntelSource {
  readonly id: string;
  readonly name: string;
  readonly status: 'done' | 'skipped' | 'failed';
  readonly note: string;
}

export interface IntelResult {
  /** Set when the whole phase was skipped (private address, disabled). */
  readonly skipped: string | null;
  readonly domains: readonly string[];
  readonly sources: readonly IntelSource[];
  readonly items: readonly IntelItem[];
  /** Hostnames seen in public sources that are not in the approved scope: reported, never tested. */
  readonly discoveredHosts: readonly string[];
  /** Archived in-scope paths worth a look by recon (hints only). */
  readonly archivedPaths: readonly string[];
  readonly callsUsed: number;
  readonly findings: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Targets

const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
const PRIVATE_SUFFIX = /\.(local|localhost|internal|lan|home|test|invalid|example)$/i;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The registrable domain of a public hostname (a small second-level list, no public-suffix database); null for IPs and single labels. */
export function apexOf(host: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isIP(h) !== 0 || !HOSTNAME.test(h)) return null;
  const labels = h.split('.');
  const tld = labels.at(-1) ?? '';
  const second = labels.at(-APEX_LABELS) ?? '';
  const keep = labels.length >= SLD_MIN_LABELS && tld.length === APEX_LABELS && SECOND_LEVEL_LABELS.has(second) ? SLD_MIN_LABELS : APEX_LABELS;
  return labels.slice(-keep).join('.');
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || PRIVATE_SUFFIX.test(host) || !host.includes('.')) return true;
  return isIP(host) !== 0 && isDisallowedAddress(host);
}

export interface IntelTargets {
  readonly origins: readonly string[];
  readonly publicOrigins: readonly string[];
  readonly inScopeHosts: ReadonlySet<string>;
  readonly apexes: readonly string[];
}

export function targetsOf(run: HuntContext['run']): IntelTargets {
  const lab = new Set(run.labOrigins.map((o) => (URL.canParse(o) ? new URL(o).origin : o)));
  const origins = run.scope.allowedOrigins.filter((o) => URL.canParse(o)).map((o) => new URL(o).origin);
  const inScopeHosts = new Set(origins.flatMap((o) => hostOf(o) ?? []));
  const publicOrigins = origins.filter((o) => {
    const host = hostOf(o);
    return host !== null && !lab.has(o) && !isPrivateHost(host) && apexOf(host) !== null;
  });
  const apexes = [...new Set(publicOrigins.flatMap((o) => apexOf(hostOf(o) ?? '') ?? []))].slice(0, MAX_APEXES);
  return { origins, publicOrigins, inScopeHosts, apexes };
}

// ---------------------------------------------------------------------------------------------------------------
// Redaction and secret patterns (gitleaks style)

const SECRET_PATTERNS: readonly { readonly name: string; readonly re: RegExp; readonly severity: IntelSeverity }[] = [
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: 'high' },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, severity: 'high' },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, severity: 'high' },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, severity: 'medium' },
  { name: 'Stripe live key', re: /\b[rs]k_live_[0-9a-zA-Z]{24,}\b/g, severity: 'critical' },
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, severity: 'critical' },
  { name: 'JSON web token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, severity: 'medium' },
  { name: 'Generic credential assignment', re: /\b(?:api[_-]?key|secret|passwd|password|token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/gi, severity: 'medium' },
];
const REDACT_VISIBLE = 4;

/** Keeps at most the first four characters; the rest never leaves this function. */
export function redactSecret(value: string): string {
  if (value.includes('PRIVATE KEY')) return '[private key redacted]';
  return `${value.slice(0, REDACT_VISIBLE)}…[redacted, ${value.length} chars]`;
}

export interface SecretHit {
  readonly pattern: string;
  readonly redacted: string;
  readonly severity: IntelSeverity;
}

export function scanSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { name, re, severity } of SECRET_PATTERNS) {
    for (const match of text.matchAll(new RegExp(re.source, re.flags))) {
      const value = match[0];
      if (/example|placeholder|your[_-]?|xxxx|changeme|<.*>/i.test(value)) continue;
      hits.push({ pattern: name, redacted: redactSecret(value), severity });
    }
  }
  return hits;
}

/** Blanks every value of KEY=VALUE lines (a `.env` body) and any secret-pattern match, for stored evidence. */
export function redactEnvBody(text: string): string {
  let out = text.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]).*$/gm, '$1[redacted]');
  for (const { re } of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, re.flags), (m) => redactSecret(m));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Phase state

interface Phase {
  readonly ctx: HuntContext;
  readonly deps: IntelDeps;
  readonly signal: AbortSignal;
  readonly maxCalls: number;
  calls: number;
  readonly items: IntelItem[];
  readonly sources: IntelSource[];
  readonly discovered: Set<string>;
  archivedPaths: string[];
  findings: number;
}

async function note(phase: Phase, kind: string, message: string, data: Record<string, unknown>): Promise<void> {
  await phase.ctx.log.emit(`intel.${kind}`, 'intel', message, data);
}

async function source(phase: Phase, id: string, name: string, status: IntelSource['status'], text: string): Promise<void> {
  phase.sources.push({ id, name, status, note: text });
  await note(phase, 'source', `${name}: ${text}`, { id, name, status });
}

function addItem(phase: Phase, item: IntelItem): void {
  if (phase.items.length < MAX_ITEMS) phase.items.push(item);
}

type Fetched = { ok: true; status: number; text: string } | { ok: false; reason: string };

/** The single door to the public intel sources: https only, allow-listed host, timeout, counted against the cap. */
async function intelFetch(phase: Phase, url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:' || !INTEL_HOSTS.includes(parsed.hostname)) return { ok: false, reason: 'host_not_allowed' };
  if (phase.signal.aborted) return { ok: false, reason: 'aborted' };
  if (phase.calls >= phase.maxCalls) return { ok: false, reason: 'call_cap' };
  phase.calls += 1;
  try {
    const res = await phase.ctx.deps.fetch(parsed, {
      method: 'GET',
      headers: { 'user-agent': 'blackwing-intel/1', accept: 'application/json', ...headers },
      redirect: 'manual',
      signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), phase.signal]),
    });
    const text = (await res.text()).slice(0, MAX_BODY_CHARS);
    return { ok: true, status: res.status, text };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'error' };
  }
}

function json<T>(schema: z.ZodType<T>, text: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const inDomain = (host: string, apex: string): boolean => host === apex || host.endsWith(`.${apex}`);

function noteHosts(phase: Phase, hosts: Iterable<string>, apex: string, targets: IntelTargets): number {
  let fresh = 0;
  for (const raw of hosts) {
    const host = raw.trim().toLowerCase().replace(/^\*\./, '');
    if (!HOSTNAME.test(host) || !inDomain(host, apex) || targets.inScopeHosts.has(host) || phase.discovered.has(host)) continue;
    if (phase.discovered.size < MAX_HOSTS) phase.discovered.add(host);
    fresh += 1;
  }
  return fresh;
}

// ---------------------------------------------------------------------------------------------------------------
// Sources

const crtSchema = z.array(z.object({ name_value: z.string() }).loose());

async function certificateTransparency(phase: Phase, targets: IntelTargets): Promise<void> {
  let total = 0;
  for (const apex of targets.apexes) {
    const res = await intelFetch(phase, `https://crt.sh/?q=${encodeURIComponent(`%.${apex}`)}&output=json`);
    const rows = res.ok && res.status === HTTP_OK ? json(crtSchema, res.text) : null;
    if (rows === null) {
      await source(phase, 'crtsh', 'Certificate transparency (crt.sh)', 'failed', res.ok ? `no usable answer (HTTP ${res.status})` : `not reachable (${res.reason})`);
      return;
    }
    total += noteHosts(phase, rows.flatMap((r) => r.name_value.split('\n')), apex, targets);
  }
  await source(phase, 'crtsh', 'Certificate transparency (crt.sh)', 'done', `${total} hostname${total === 1 ? '' : 's'} outside the approved scope, reported as discovered and not tested`);
}

const cdxSchema = z.array(z.array(z.string()));
const INTERESTING_ARCHIVE = /(\.(?:env|git|sql|bak|old|zip|tar|gz|log|conf|config|ini|ya?ml|pem|key|swp)(?:$)|\/(?:\.git|\.env|admin|backup|phpmyadmin|swagger|api-docs|graphql|debug|internal)(?:\/|$))/i;

async function webArchive(phase: Phase, targets: IntelTargets): Promise<void> {
  const interesting = new Set<string>();
  let urls = 0;
  for (const apex of targets.apexes) {
    const res = await intelFetch(phase, `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(`*.${apex}`)}&output=json&fl=original&collapse=urlkey&filter=statuscode:200&limit=300`);
    const rows = res.ok && res.status === HTTP_OK ? json(cdxSchema, res.text) : null;
    if (rows === null) {
      await source(phase, 'wayback', 'Web archive (Wayback CDX)', 'failed', res.ok ? `no usable answer (HTTP ${res.status})` : `not reachable (${res.reason})`);
      return;
    }
    for (const row of rows.slice(1)) {
      const original = row[0] ?? '';
      let url: URL;
      try {
        url = new URL(original);
      } catch {
        continue;
      }
      urls += 1;
      noteHosts(phase, [url.hostname], apex, targets);
      // Query strings can carry tokens: only host and path are kept.
      if (targets.inScopeHosts.has(url.hostname.toLowerCase()) && INTERESTING_ARCHIVE.test(url.pathname)) interesting.add(url.pathname.slice(0, PATH_MAX_CHARS));
    }
  }
  phase.archivedPaths = [...interesting].slice(0, MAX_ARCHIVED_SHOWN);
  if (phase.archivedPaths.length > 0) {
    addItem(phase, { source: 'wayback', title: 'Archived sensitive-looking paths on approved hosts', detail: `${interesting.size} archived path${interesting.size === 1 ? '' : 's'} such as ${phase.archivedPaths.slice(0, SHOWN_FEW).join(', ')}`, severity: 'info', basis: 'unverified' });
  }
  await source(phase, 'wayback', 'Web archive (Wayback CDX)', 'done', `${urls} archived URL${urls === 1 ? '' : 's'} read, ${interesting.size} sensitive-looking on approved hosts`);
}

const githubSchema = z.object({
  total_count: z.number().optional(),
  items: z
    .array(
      z.object({
        path: z.string().optional(),
        repository: z.object({ full_name: z.string().optional(), owner: z.object({ type: z.string().optional() }).optional() }).optional(),
        text_matches: z.array(z.object({ fragment: z.string().optional() })).optional(),
      }),
    )
    .default([]),
});

async function publicCode(phase: Phase, targets: IntelTargets, config: IntelConfig): Promise<void> {
  if (config.githubToken === null) {
    await source(phase, 'github', 'Public code search (GitHub)', 'skipped', 'skipped: no BW_GITHUB_TOKEN is configured');
    return;
  }
  let matches = 0;
  let snippets = 0;
  const seen = new Set<string>();
  for (const apex of targets.apexes) {
    const res = await intelFetch(phase, `https://api.github.com/search/code?q=${encodeURIComponent(`"${apex}"`)}&per_page=${GITHUB_SNIPPETS}`, {
      accept: 'application/vnd.github.text-match+json',
      authorization: `Bearer ${config.githubToken}`,
      'x-github-api-version': '2022-11-28',
    });
    const body = res.ok && res.status === HTTP_OK ? json(githubSchema, res.text) : null;
    if (body === null) {
      await source(phase, 'github', 'Public code search (GitHub)', 'failed', res.ok ? `no usable answer (HTTP ${res.status})` : `not reachable (${res.reason})`);
      return;
    }
    matches += body.total_count ?? body.items.length;
    for (const item of body.items) {
      const text = (item.text_matches ?? []).map((m) => m.fragment ?? '').join('\n');
      snippets += 1;
      // A personal repository is never named: only organisation-owned ones are.
      const org = item.repository?.owner?.type === 'Organization';
      const where = org ? `${item.repository?.full_name ?? 'an organisation repository'}${item.path === undefined ? '' : `:${item.path}`}` : 'a personal repository';
      for (const hit of scanSecrets(text)) {
        const key = `${hit.pattern}|${hit.redacted}|${where}`;
        if (seen.has(key)) continue;
        seen.add(key);
        addItem(phase, {
          source: 'github',
          title: `Possible ${hit.pattern} in public code that mentions the domain`,
          detail: `${hit.redacted} in ${where}. Not tested against any service; rotate it if it is real.`,
          severity: hit.severity,
          basis: 'unverified',
        });
      }
    }
  }
  await source(phase, 'github', 'Public code search (GitHub)', 'done', `${matches} public code match${matches === 1 ? '' : 'es'} for the domain, ${snippets} snippet${snippets === 1 ? '' : 's'} checked for secret patterns (secrets redacted)`);
}

const DKIM_SELECTORS = ['default', 'google', 'selector1', 'selector2', 'k1', 's1', 'mail', 'dkim'];

async function dnsPosture(phase: Phase, targets: IntelTargets): Promise<void> {
  const counted = async <T>(run: () => Promise<T>): Promise<T | null> => {
    if (phase.calls >= phase.maxCalls || phase.signal.aborted) return null;
    phase.calls += 1;
    try {
      return await Promise.race([run(), new Promise<null>((resolve) => { setTimeout(() => { resolve(null); }, FETCH_TIMEOUT_MS).unref(); })]);
    } catch {
      return [] as unknown as T;
    }
  };
  const notes: string[] = [];
  for (const apex of targets.apexes) {
    const txt = (await counted(() => phase.deps.resolveTxt(apex))) ?? [];
    const spf = txt.map((r) => r.join('')).find((r) => /^v=spf1\b/i.test(r));
    const dmarcRecords = (await counted(() => phase.deps.resolveTxt(`_dmarc.${apex}`))) ?? [];
    const dmarc = dmarcRecords.map((r) => r.join('')).find((r) => /^v=DMARC1\b/i.test(r));
    const mx = (await counted(() => phase.deps.resolveMx(apex))) ?? [];
    const selectors: string[] = [];
    for (const selector of DKIM_SELECTORS) {
      const answer = (await counted(() => phase.deps.resolveTxt(`${selector}._domainkey.${apex}`))) ?? [];
      if (answer.length > 0) selectors.push(selector);
    }
    const mail = mx.length > 0;
    notes.push(`${apex}: ${mail ? `${mx.length} MX` : 'no MX'}, SPF ${spf === undefined ? 'absent' : 'present'}, DMARC ${dmarc === undefined ? 'absent' : 'present'}, DKIM selectors seen: ${selectors.length === 0 ? 'none of the common ones' : selectors.join(', ')}`);
    if (spf === undefined && mail) addItem(phase, { source: 'dns', title: `No SPF record for ${apex}`, detail: 'The domain receives mail but publishes no SPF policy, so others can spoof it more easily.', severity: 'medium', basis: 'observed' });
    else if (spf !== undefined && /\+all\b/.test(spf)) addItem(phase, { source: 'dns', title: `SPF for ${apex} allows any sender`, detail: 'The SPF record ends in +all.', severity: 'high', basis: 'observed' });
    else if (spf !== undefined && /\?all\b/.test(spf)) addItem(phase, { source: 'dns', title: `SPF for ${apex} is neutral`, detail: 'The SPF record ends in ?all, which gives no protection.', severity: 'low', basis: 'observed' });
    if (dmarc === undefined && mail) addItem(phase, { source: 'dns', title: `No DMARC record for ${apex}`, detail: 'Without DMARC, receivers have no policy for mail that fails SPF or DKIM.', severity: 'medium', basis: 'observed' });
    else if (dmarc !== undefined && /\bp\s*=\s*none\b/i.test(dmarc)) addItem(phase, { source: 'dns', title: `DMARC for ${apex} only monitors (p=none)`, detail: 'Spoofed mail is reported but not rejected or quarantined.', severity: 'low', basis: 'observed' });
  }
  await source(phase, 'dns', 'DNS and e-mail security', 'done', notes.join('; ') || 'no domain to check');
}

const hibpSchema = z.record(z.string(), z.array(z.string()));

async function breachExposure(phase: Phase, targets: IntelTargets, config: IntelConfig): Promise<void> {
  if (config.hibpApiKey === null) {
    await source(phase, 'hibp', 'Breach exposure (HIBP domain search)', 'skipped', 'skipped: no BW_HIBP_API_KEY is configured');
    return;
  }
  for (const apex of targets.apexes) {
    const res = await intelFetch(phase, `https://haveibeenpwned.com/api/v3/breacheddomain/${encodeURIComponent(apex)}`, { 'hibp-api-key': config.hibpApiKey });
    if (res.ok && res.status === HTTP_NOT_FOUND) continue;
    const map = res.ok && res.status === HTTP_OK ? json(hibpSchema, res.text) : null;
    if (map === null) {
      await source(phase, 'hibp', 'Breach exposure (HIBP domain search)', 'failed', res.ok ? `no usable answer (HTTP ${res.status}; the domain must be verified with the service)` : `not reachable (${res.reason})`);
      return;
    }
    // Counts only: the aliases themselves are personal data and are dropped here.
    const addresses = Object.keys(map).length;
    const breaches = [...new Set(Object.values(map).flat())];
    addItem(phase, {
      source: 'hibp',
      title: `${addresses} corporate e-mail address${addresses === 1 ? '' : 'es'} at ${apex} appear in public breaches`,
      detail: `Across ${breaches.length} breach${breaches.length === 1 ? '' : 'es'}${breaches.length === 0 ? '' : `: ${breaches.slice(0, SHOWN_BREACHES).join(', ')}`}. Individual addresses are not collected.`,
      severity: addresses > 0 ? 'medium' : 'info',
      basis: 'unverified',
    });
  }
  await source(phase, 'hibp', 'Breach exposure (HIBP domain search)', 'done', 'domain-level counts only');
}

// --- exposed files on the target itself ---------------------------------------------------------------------------

interface ExposureProbe {
  readonly path: string;
  readonly title: string;
  readonly cwe: string;
  readonly severity: Candidate['severity'];
  readonly oracle: Candidate['oracle'];
  readonly why: string;
  /** The body holds secrets: stored evidence is blanked. */
  readonly secretBody?: boolean;
}

export const EXPOSURE_PROBES: readonly ExposureProbe[] = [
  { path: '/.git/HEAD', title: 'Exposed Git repository metadata', cwe: 'CWE-527', severity: 'high', oracle: { type: 'body_regex', value: '^ref: refs/(heads|remotes)/' }, why: 'The repository metadata is readable, which usually allows the whole source history to be downloaded.' },
  { path: '/.git/config', title: 'Exposed Git configuration', cwe: 'CWE-527', severity: 'high', oracle: { type: 'body_regex', value: '\\[core\\]' }, why: 'The Git configuration is readable and may name private remotes.' },
  { path: '/.env', title: 'Exposed environment file', cwe: 'CWE-538', severity: 'high', oracle: { type: 'body_regex', value: '(^|\\n)[A-Z][A-Z0-9_]{2,}=' }, why: 'An environment file is readable; such files usually hold credentials and keys.', secretBody: true },
  { path: '/.DS_Store', title: 'Exposed .DS_Store file', cwe: 'CWE-538', severity: 'low', oracle: { type: 'body_contains', value: 'Bud1' }, why: 'The macOS directory index lists file names that were never meant to be public.' },
  { path: '/backup.sql', title: 'Exposed database dump', cwe: 'CWE-530', severity: 'high', oracle: { type: 'body_regex', value: '(CREATE TABLE|INSERT INTO|DROP TABLE)' }, why: 'A database dump is downloadable.', secretBody: true },
  { path: '/dump.sql', title: 'Exposed database dump', cwe: 'CWE-530', severity: 'high', oracle: { type: 'body_regex', value: '(CREATE TABLE|INSERT INTO|DROP TABLE)' }, why: 'A database dump is downloadable.', secretBody: true },
  { path: '/backup.zip', title: 'Exposed backup archive', cwe: 'CWE-530', severity: 'high', oracle: { type: 'body_regex', value: '^PK\\x03\\x04' }, why: 'A backup archive is downloadable.' },
  { path: '/site.zip', title: 'Exposed backup archive', cwe: 'CWE-530', severity: 'high', oracle: { type: 'body_regex', value: '^PK\\x03\\x04' }, why: 'A site archive is downloadable.' },
  { path: '/config.php.bak', title: 'Exposed configuration backup', cwe: 'CWE-530', severity: 'high', oracle: { type: 'body_regex', value: '<\\?php' }, why: 'A backup copy of a configuration file is served as text.', secretBody: true },
  { path: '/web.config.bak', title: 'Exposed configuration backup', cwe: 'CWE-530', severity: 'high', oracle: { type: 'body_contains', value: '<configuration' }, why: 'A backup copy of a configuration file is served as text.', secretBody: true },
  { path: '/phpinfo.php', title: 'Exposed PHP information page', cwe: 'CWE-200', severity: 'low', oracle: { type: 'body_contains', value: 'PHP Version' }, why: 'The page lists the server configuration and environment.' },
];

function candidateFor(origin: string, probe: ExposureProbe): Candidate {
  const url = `${origin}${probe.path}`;
  return {
    title: `${probe.title} (${probe.path})`,
    vulnClass: 'Sensitive information exposure',
    cwe: probe.cwe,
    owasp: 'A05:2021 Security Misconfiguration',
    severity: probe.severity,
    description: `${probe.why} Found by the passive threat-intel phase with a plain GET to ${url}; the content is redacted in storage.`,
    remediation: 'Remove the file from the web root and block such paths at the web server; rotate any credential it contained.',
    probe: { method: 'GET', url },
    oracle: probe.oracle,
  };
}

async function exposedFiles(phase: Phase, targets: IntelTargets): Promise<void> {
  const { ctx } = phase;
  const limit = Math.max(1, Math.floor(ctx.run.budgetRequests * PROBE_SHARE));
  let probes = 0;
  let found = 0;
  for (const origin of targets.origins.slice(0, MAX_ORIGINS)) {
    for (const probe of EXPOSURE_PROBES) {
      if (phase.signal.aborted || probes >= limit) break;
      const candidate = candidateFor(origin, probe);
      if (!checkScope(candidate.probe.url, ctx.run.scope).ok) continue;
      probes += 1;
      const verdict = await validateCandidate(candidate, {
        send: (request) => sendRequest(ctx, 'validator', request, { purpose: `threat intel: check ${probe.path}`, askGate2: false }),
        replay: (n, status, matched) => ctx.log.emit('validator.replay', 'validator', `Replay ${n}: status ${status}, oracle ${matched ? 'matched' : 'did not match'}`, { n, status, matched, intel: true }),
        control: () => Promise.resolve(),
      });
      if (!verdict.confirmed || verdict.probe === null) continue;
      found += 1;
      const { proven, row } = buildFindingRow({ run: ctx.run, candidate, verdict, agent: 'recon', testCaseId: null, credentialHeader: undefined });
      if (!proven) continue;
      const safeRow = probe.secretBody === true ? { ...row, evidence: redactEvidence(row.evidence) } : row;
      const findingId = await recordProven(ctx, { ...safeRow, id: newId() }, { title: row.title, severity: row.severity, intel: true });
      if (findingId !== null) phase.findings += 1;
      addItem(phase, { source: 'target', title: row.title, detail: `${probe.why} Confirmed by 3 replays at ${probe.path}.`, severity: probe.severity, basis: 'finding', findingId });
      await note(phase, 'finding', `Exposure confirmed: ${row.title}`, { path: probe.path, severity: probe.severity, findingId });
    }
  }
  await source(phase, 'target', 'Exposed version-control and configuration files', 'done', `${probes} path${probes === 1 ? '' : 's'} checked on the approved origin${targets.origins.length === 1 ? '' : 's'}, ${found} exposed`);
}

function redactEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactEnvBody(value);
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(evidence) as Record<string, unknown>;
}

// --- banner CVEs ---------------------------------------------------------------------------------------------------

/** Server and framework banners to CPE vendor/product pairs; only products with a version are looked up. */
const BANNERS: readonly { readonly re: RegExp; readonly vendor: string; readonly product: string; readonly label: string }[] = [
  { re: /\bnginx\/(\d+(?:\.\d+){1,3})/i, vendor: 'f5', product: 'nginx', label: 'nginx' },
  { re: /\bapache(?:\/| httpd\/)(\d+(?:\.\d+){1,3})/i, vendor: 'apache', product: 'http_server', label: 'Apache HTTP Server' },
  { re: /\bPHP\/(\d+(?:\.\d+){1,3})/i, vendor: 'php', product: 'php', label: 'PHP' },
  { re: /\bMicrosoft-IIS\/(\d+(?:\.\d+)?)/i, vendor: 'microsoft', product: 'internet_information_services', label: 'Microsoft IIS' },
  { re: /\bOpenSSL\/(\d+\.\d+\.\d+[a-z]?)/i, vendor: 'openssl', product: 'openssl', label: 'OpenSSL' },
  { re: /\bTomcat\/(\d+(?:\.\d+){1,2})/i, vendor: 'apache', product: 'tomcat', label: 'Apache Tomcat' },
  { re: /\blighttpd\/(\d+(?:\.\d+){1,2})/i, vendor: 'lighttpd', product: 'lighttpd', label: 'lighttpd' },
];

export function detectBanners(headers: Record<string, string>): { vendor: string; product: string; label: string; version: string }[] {
  const text = [headers.server, headers['x-powered-by'], headers['x-aspnet-version'] === undefined ? undefined : `ASP.NET/${headers['x-aspnet-version']}`].filter((v): v is string => v !== undefined).join(' ; ');
  return BANNERS.flatMap((b) => {
    const version = b.re.exec(text)?.[1];
    return version === undefined ? [] : [{ vendor: b.vendor, product: b.product, label: b.label, version }];
  });
}

const nvdSchema = z.object({
  vulnerabilities: z
    .array(
      z.object({
        cve: z.object({
          id: z.string(),
          descriptions: z.array(z.object({ lang: z.string(), value: z.string() })).default([]),
          metrics: z.object({ cvssMetricV31: z.array(z.object({ cvssData: z.object({ baseScore: z.number() }) })).optional() }).loose().optional(),
        }),
      }),
    )
    .default([]),
});

const severityOf = (score: number): IntelSeverity => (score >= NVD_CRITICAL ? 'critical' : score >= NVD_HIGH ? 'high' : score >= NVD_MEDIUM ? 'medium' : 'low');

async function bannerCves(phase: Phase, targets: IntelTargets): Promise<void> {
  const origin = targets.publicOrigins[0];
  if (origin === undefined) return;
  const root: HttpResult = await sendRequest(phase.ctx, 'validator', { method: 'GET', url: `${origin}/` }, { purpose: 'threat intel: read response banners', askGate2: false });
  if (!root.ok) {
    await source(phase, 'cve', 'Known CVEs for detected versions', 'failed', 'the approved origin could not be read for banners');
    return;
  }
  const banners = detectBanners(root.headers);
  if (banners.length === 0) {
    await source(phase, 'cve', 'Known CVEs for detected versions', 'done', 'no versioned server or framework banner was exposed');
    return;
  }
  let listed = 0;
  for (const b of banners) {
    const cpe = `cpe:2.3:a:${b.vendor}:${b.product}:${b.version}:*:*:*:*:*:*:*`;
    const res = await intelFetch(phase, `https://services.nvd.nist.gov/rest/json/cves/2.0?cpeName=${encodeURIComponent(cpe)}&resultsPerPage=40`);
    const body = res.ok && res.status === HTTP_OK ? json(nvdSchema, res.text) : null;
    if (body === null) continue;
    const scored = body.vulnerabilities
      .map((v) => ({ id: v.cve.id, score: v.cve.metrics?.cvssMetricV31?.[0]?.cvssData.baseScore ?? 0, text: v.cve.descriptions.find((d) => d.lang === 'en')?.value ?? '' }))
      .sort((a, c) => c.score - a.score)
      .slice(0, MAX_CVES_PER_PRODUCT);
    addItem(phase, {
      source: 'cve',
      title: `${b.label} ${b.version} is announced in the response headers`,
      detail: scored.length === 0 ? 'No published CVE matches this exact version in the NVD. Hiding the version still reduces what attackers learn.' : `Published CVEs for this version (a version match only: patches may have been back-ported): ${scored.map((c) => `${c.id}${c.score > 0 ? ` (CVSS ${c.score})` : ''}`).join(', ')}.`,
      severity: scored.length === 0 ? 'info' : severityOf(scored[0]?.score ?? 0),
      basis: 'unverified',
    });
    listed += scored.length;
  }
  await source(phase, 'cve', 'Known CVEs for detected versions', 'done', `${banners.map((b) => `${b.label} ${b.version}`).join(', ')}: ${listed} CVE${listed === 1 ? '' : 's'} listed (NVD)`);
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points

/** Runs the whole phase. Never throws: a source that fails is recorded as failed and the next one runs. */
export async function runIntel(ctx: HuntContext, config: IntelConfig, deps: IntelDeps = defaultDeps): Promise<IntelResult> {
  const targets = targetsOf(ctx.run);
  const maxCalls = Math.min(MAX_CALLS, Math.max(MIN_CALLS, Math.floor(ctx.run.budgetRequests * CALL_SHARE)));
  const phaseMs = Math.min(MAX_PHASE_S, Math.max(MIN_CALLS, ctx.run.budgetSeconds * PHASE_SHARE)) * MS_PER_S;
  const phase: Phase = {
    ctx,
    deps,
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(phaseMs)]),
    maxCalls,
    calls: 0,
    items: [],
    sources: [],
    discovered: new Set(),
    archivedPaths: [],
    findings: 0,
  };
  const isPublic = targets.apexes.length > 0;
  await note(phase, 'started', 'Threat intel: passive external reconnaissance before testing', { domains: targets.apexes, maxCalls });
  const steps: [string, () => Promise<void>][] = [];
  if (isPublic) {
    steps.push(
      ['crtsh', () => certificateTransparency(phase, targets)],
      ['wayback', () => webArchive(phase, targets)],
      ['github', () => publicCode(phase, targets, config)],
      ['dns', () => dnsPosture(phase, targets)],
      ['hibp', () => breachExposure(phase, targets, config)],
    );
  } else {
    await source(phase, 'internet', 'Public intel sources', 'skipped', PRIVATE_SKIP_MESSAGE);
  }
  steps.push(['target', () => exposedFiles(phase, targets)]);
  if (isPublic) steps.push(['cve', () => bannerCves(phase, targets)]);
  for (const [id, step] of steps) {
    try {
      await step();
    } catch (error) {
      await source(phase, id, id, 'failed', `failed (${error instanceof Error ? error.name : 'error'})`);
    }
  }
  const result: IntelResult = {
    skipped: isPublic ? null : PRIVATE_SKIP_MESSAGE,
    domains: targets.apexes,
    sources: phase.sources,
    items: phase.items,
    discoveredHosts: [...phase.discovered].sort(),
    archivedPaths: phase.archivedPaths,
    callsUsed: phase.calls,
    findings: phase.findings,
  };
  await note(phase, 'summary', isPublic ? `Threat intel done: ${result.items.length} item${result.items.length === 1 ? '' : 's'}, ${result.discoveredHosts.length} host${result.discoveredHosts.length === 1 ? '' : 's'} discovered outside scope` : PRIVATE_SKIP_MESSAGE, { ...result });
  return result;
}

/** What the planner is told: hints from the public view, with the explicit rule that discovered hosts are not to be tested. */
export function briefingOf(result: IntelResult): string {
  const lines = ['Threat intel (passive, gathered by Blackwing before testing; hints only, not verified unless marked as a finding):'];
  if (result.skipped !== null) lines.push(`- ${result.skipped}.`);
  if (result.discoveredHosts.length > 0) lines.push(`- ${result.discoveredHosts.length} hostnames of the organisation were seen in public sources outside the approved scope (${result.discoveredHosts.slice(0, SHOWN_HOSTS).join(', ')}). Do not test them; scope refuses them anyway.`);
  if (result.archivedPaths.length > 0) lines.push(`- Archived paths on approved hosts worth a recon look: ${result.archivedPaths.slice(0, SHOWN_HOSTS).join(', ')}.`);
  for (const item of result.items.filter((i) => i.source !== 'github' && i.source !== 'hibp').slice(0, SHOWN_ITEMS)) {
    lines.push(`- [${item.basis === 'finding' ? 'confirmed finding' : 'intel, not verified'}] ${item.title}: ${item.detail}`);
  }
  if (lines.length === 1) lines.push('- Nothing notable was found.');
  lines.push('Use it to prioritise test cases (for example, versions with known CVEs, exposed paths) but still prove everything through submit_candidate.');
  return lines.join('\n');
}
