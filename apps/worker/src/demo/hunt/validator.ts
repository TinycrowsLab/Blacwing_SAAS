// Deterministic validator. A finding is `confirmed` only if the probe matches the oracle on all replays and the
// negative control, which differs from the probe in exactly one part, does not. Blackwing proposes the candidate, its
// oracle and its control; it never decides confirmation.
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { owaspTop10Title } from '@blackwing/domain';
import { scrub, scrubDeep } from '@blackwing/errors/scrub';

import { probeSchema, type HttpRequest, type HttpResult, type SentRequest } from './http-tool.js';
import { classifyMethod } from './scope.js';

import type { FindingRow, HuntRun, RetestJob, RetestResult } from './types.js';

export const REPLAYS = 3;
const EXCERPT_CHARS = 2000;
const EXCERPT_CONTEXT_CHARS = 300;
const MAX_ORACLE_VALUE_CHARS = 500;
const MAX_TITLE_CHARS = 200;
const MAX_VULN_CLASS_CHARS = 100;
const MAX_CWE_CHARS = 20;
const MAX_OWASP_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_REMEDIATION_CHARS = 1000;

const OWASP_CODES = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08', 'A09', 'A10'];

/** `"A03:2021 Injection"` from free text (`"A03:2021-Injection"`, `"OWASP A3"`, `"a03"`); null when no A01..A10 code. */
export function canonicalOwasp(text: string): string | null {
  const n = /\bA\s*0?(10|[1-9])\b/i.exec(text)?.[1];
  if (n === undefined) return null;
  const id = n === '10' ? 'A10' : `A0${n}`;
  const title = owaspTop10Title(id);
  return title === null ? null : `${id}:2021 ${title}`;
}

export const oracleSchema = z.object({
  type: z.enum(['body_contains', 'body_regex', 'status_equals', 'header_contains']),
  /** header_contains takes `Header-Name: substring`. */
  value: z.string().min(1).max(MAX_ORACLE_VALUE_CHARS),
});
export type Oracle = z.infer<typeof oracleSchema>;

export const candidateSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  vulnClass: z.string().min(1).max(MAX_VULN_CLASS_CHARS),
  cwe: z.string().min(1).max(MAX_CWE_CHARS),
  owasp: z
    .string()
    .min(1)
    .max(MAX_OWASP_CHARS)
    .refine((value) => canonicalOwasp(value) !== null, {
      message: `owasp must name an OWASP Top 10 2021 category: ${OWASP_CODES.join(', ')} (for example "A03:2021 Injection")`,
    }),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  description: z.string().min(1).max(MAX_DESCRIPTION_CHARS),
  /** The model's fix suggestion, shown labelled "not verified". Optional: the console hides the block when absent. */
  remediation: z.string().max(MAX_REMEDIATION_CHARS).optional(),
  probe: probeSchema,
  /** Leave it out only for data open to everyone (exposure template): the probe is then sent signed out and replayed. */
  control: probeSchema.optional(),
  oracle: oracleSchema,
});
export type Candidate = z.infer<typeof candidateSchema>;

type Sent = Extract<HttpResult, { ok: true }>;

export interface ReplayRecord {
  readonly n: number;
  readonly status: number;
  readonly matched: boolean;
  readonly bodySha256: string;
}

/** The one part of the request the negative control changes. */
export type Delta = 'query' | 'body' | 'header' | 'role' | 'path_segment' | 'none';

export interface Verdict {
  readonly confirmed: boolean;
  readonly reason: string;
  /** Null when the control was refused before anything was sent (not a single-delta control). */
  readonly delta: Delta | null;
  readonly replays: readonly ReplayRecord[];
  readonly probe: Sent | null;
  readonly control: Sent | null;
  readonly controlMatched: boolean | null;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function oracleMatches(oracle: Oracle, response: Pick<Sent, 'status' | 'headers' | 'body'>): boolean {
  switch (oracle.type) {
    case 'body_contains':
      return response.body.includes(oracle.value);
    case 'body_regex':
      try {
        return new RegExp(oracle.value).test(response.body);
      } catch {
        return false;
      }
    case 'status_equals':
      return response.status === Number(oracle.value);
    case 'header_contains': {
      const split = oracle.value.indexOf(':');
      const name = split < 0 ? null : oracle.value.slice(0, split).trim().toLowerCase();
      const needle = (split < 0 ? oracle.value : oracle.value.slice(split + 1)).trim().toLowerCase();
      return Object.entries(response.headers).some(([key, value]) => (name === null || key.toLowerCase() === name) && value.toLowerCase().includes(needle));
    }
  }
}

export interface ValidatorHooks {
  /** Sends one request through the normal scope/method/budget rules, without raising new Gate 2 requests. */
  send(request: HttpRequest): Promise<HttpResult>;
  replay(n: number, status: number, matched: boolean): Promise<void>;
  control(status: number, matched: boolean): Promise<void>;
}

const normHeaders = (headers: HttpRequest['headers']): string =>
  JSON.stringify(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]).sort(([a = ''], [b = '']) => (a < b ? -1 : 1)));

/**
 * The control must be the probe with exactly one part changed: same method, same origin, and one of the query string,
 * the body, the header set, the test account role or a single path segment differs. Anything else proves nothing.
 */
export function controlDelta(probe: HttpRequest, control: HttpRequest): { ok: true; delta: Delta } | { ok: false; differs: string } {
  let p: URL;
  let c: URL;
  try {
    p = new URL(probe.url);
    c = new URL(control.url);
  } catch {
    return { ok: false, differs: 'the URL does not parse' };
  }
  const differs: string[] = [];
  if (probe.method.toUpperCase() !== control.method.toUpperCase()) differs.push('method');
  if (p.origin !== c.origin) differs.push('origin');
  if (p.pathname !== c.pathname) {
    const ps = p.pathname.split('/');
    const cs = c.pathname.split('/');
    const changed = ps.length === cs.length ? ps.filter((segment, i) => segment !== cs[i]).length : Infinity;
    differs.push(changed === 1 ? 'path_segment' : 'path');
  }
  if (p.search !== c.search) differs.push('query');
  if ((probe.body ?? '') !== (control.body ?? '')) differs.push('body');
  if (normHeaders(probe.headers) !== normHeaders(control.headers)) differs.push('header');
  if ((probe.as_role ?? '').toLowerCase() !== (control.as_role ?? '').toLowerCase()) differs.push('role');
  const [only] = differs;
  if (differs.length === 1 && only !== undefined && only !== 'method' && only !== 'origin' && only !== 'path') return { ok: true, delta: only as Delta };
  return { ok: false, differs: differs.length === 0 ? 'nothing (the control is the probe)' : differs.join(', ') };
}

/** CWE numbers of broken access control: a signed-out control only shows a page needs a sign-in, never that a role should be refused. */
const ACCESS_CONTROL_CWES = new Set('269 284 285 425 566 639 732 862 863 1220'.split(' '));
const ACCESS_CONTROL_WORDS = /\b(idor|bola|bfla|access control|authori[sz]ation|privilege|forced browsing)\b/i;
/** CWE numbers of data open to anyone: no control request can differ in one part, so the probe is replayed alone. */
const EXPOSURE_CWES = new Set('200 201 209 213 215 256 260 306 312 359 497 522 527 528 530 532 538 540 548 552 615'.split(' '));
const EXPOSURE_WORDS = /\b(exposure|exposed|disclosure|leak|directory listing|unauthenticated|missing authentication|backup file)\b/i;
const CREDENTIAL_HEADER = /^(authorization|cookie|x-api-key|x-auth-token|x-access-token|api-key)$/i;
const NOT_FOUND = 404;
const GONE = 410;
const MISSING_PAGE = new Set([NOT_FOUND, GONE]);

type ClassOf = Partial<Pick<Candidate, 'cwe' | 'vulnClass' | 'title'>>;
const cweNumber = (c: ClassOf): string => /\d+/.exec(c.cwe ?? '')?.[0]?.replace(/^0+/, '') ?? '';
const classText = (c: ClassOf): string => `${c.vulnClass ?? ''} ${c.title ?? ''}`;
const isAccessControl = (c: ClassOf): boolean => ACCESS_CONTROL_CWES.has(cweNumber(c)) || ACCESS_CONTROL_WORDS.test(classText(c));
const isExposure = (c: ClassOf): boolean => EXPOSURE_CWES.has(cweNumber(c)) || EXPOSURE_WORDS.test(classText(c));
const signedOut = (r: HttpRequest): boolean => r.as_role === undefined && !Object.keys(r.headers ?? {}).some((name) => CREDENTIAL_HEADER.test(name));

/**
 * Class templates on top of the single-delta rule: an access-control finding needs two signed-in identities (or the
 * same identity on another object), never "role vs signed out"; a candidate without a control is accepted only for an
 * exposure class, sent signed out, with a check on the content (a status alone proves nothing). Null when it may run.
 */
export function templateRefusal(candidate: Pick<Candidate, 'probe' | 'control' | 'oracle'> & ClassOf): string | null {
  const { probe, control, oracle } = candidate;
  if (control === undefined) {
    if (!isExposure(candidate)) return 'no_control: only data open to everyone may be proven without a control';
    if (!signedOut(probe)) return 'no_control_signed_in: data open to everyone is proven signed out';
    if (oracle.type === 'status_equals') return 'no_control_status_only: a status code alone does not show exposed data';
    return null;
  }
  if (isAccessControl(candidate) && signedOut(control) !== signedOut(probe)) {
    return 'access_control_signed_out_control: a signed-out control shows only that a sign-in is needed';
  }
  return null;
}

/** The differing path segments of probe and control name the same resource when one contains the other. */
function samePathResource(probeUrl: string, controlUrl: string): boolean {
  const p = new URL(probeUrl).pathname.split('/');
  const c = new URL(controlUrl).pathname.split('/');
  const i = p.findIndex((segment, n) => segment !== c[n]);
  const a = (p[i] ?? '').toLowerCase();
  const b = (c[i] ?? '').toLowerCase();
  return a !== '' && b !== '' && (a.includes(b) || b.includes(a));
}

/** GET/HEAD/OPTIONS that do not look state-changing are replayed 3 times; anything that may change data, once. */
export function replaysFor(probe: HttpRequest): number {
  try {
    return classifyMethod(probe.method, new URL(probe.url)) === 'active_safe' ? REPLAYS : 1;
  } catch {
    return 1;
  }
}

/**
 * Checks the class template and that the control is single-delta (nothing sent otherwise), replays the probe, then
 * sends the control once. Without a control (exposure template) the replays alone decide.
 */
export async function validateCandidate(candidate: Pick<Candidate, 'probe' | 'control' | 'oracle'> & ClassOf, hooks: ValidatorHooks): Promise<Verdict> {
  const refused = (reason: string): Verdict => ({ confirmed: false, reason, delta: null, replays: [], probe: null, control: null, controlMatched: null });
  const template = templateRefusal(candidate);
  if (template !== null) return refused(template);
  const shape = candidate.control === undefined ? ({ ok: true, delta: 'none' } as const) : controlDelta(candidate.probe, candidate.control);
  if (!shape.ok) return refused(`control_not_single_delta: ${shape.differs} differ`);
  const { delta } = shape;
  const replays: ReplayRecord[] = [];
  let probe: Sent | null = null;
  const planned = replaysFor(candidate.probe);
  for (let n = 1; n <= planned; n += 1) {
    const result = await hooks.send(candidate.probe);
    if (!result.ok) return { confirmed: false, reason: `probe replay ${n} not sent: ${result.refusal}`, delta, replays, probe, control: null, controlMatched: null };
    probe = result;
    const matched = oracleMatches(candidate.oracle, result);
    replays.push({ n, status: result.status, matched, bodySha256: sha256(result.body) });
    await hooks.replay(n, result.status, matched);
    if (!matched) return { confirmed: false, reason: `probe replay ${n} did not match the oracle`, delta, replays, probe, control: null, controlMatched: null };
  }
  if (candidate.control === undefined) {
    return { confirmed: true, reason: 'all probe replays matched; no control is possible for data open to everyone', delta, replays, probe, control: null, controlMatched: null };
  }
  const control = await hooks.send(candidate.control);
  if (!control.ok) return { confirmed: false, reason: `negative control not sent: ${control.refusal}`, delta, replays, probe, control: null, controlMatched: null };
  const controlMatched = oracleMatches(candidate.oracle, control);
  await hooks.control(control.status, controlMatched);
  if (controlMatched) return { confirmed: false, reason: 'the negative control also matched the oracle', delta, replays, probe, control, controlMatched };
  // A page that does not exist never matches anything: it is not a control for another resource. A payload in the
  // segment (`/users/test'` vs `/users/test`) keeps the resource, so its 404 control still counts.
  if (delta === 'path_segment' && MISSING_PAGE.has(control.status) && !samePathResource(candidate.probe.url, candidate.control.url)) {
    return { confirmed: false, reason: 'control_page_missing: the control asked for a page that does not exist', delta, replays, probe, control, controlMatched };
  }
  return { confirmed: true, reason: 'all probe replays matched and the negative control did not', delta, replays, probe, control, controlMatched };
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Lower-case path, numeric and uuid segments as `:id`, no trailing slash. */
export function normalisedPath(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = url.toLowerCase();
  }
  const segments = path.split('/').map((s) => (/^\d+$/.test(s) || UUID_SEGMENT.test(s) ? ':id' : s));
  const joined = segments.join('/').replace(/\/+$/, '');
  return joined === '' ? '/' : joined;
}

/** The same issue across runs and agents: sha256(asset | METHOD | normalised path | CWE). */
export function identityKey(assetId: string, candidate: Pick<Candidate, 'probe' | 'cwe'>): string {
  const digits = /\d+/.exec(candidate.cwe)?.[0];
  const cwe = digits === undefined ? candidate.cwe.trim().toUpperCase() : `CWE-${digits}`;
  return sha256([assetId, candidate.probe.method.toUpperCase(), normalisedPath(candidate.probe.url), cwe].join('|'));
}

/** Unique per run (two agents' copies merge); a later run stores its own row with the same identity key. */
export function fingerprint(runId: string, identity: string): string {
  return sha256([runId, identity].join('|'));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const ROLE_PLACEHOLDER = /^\[redacted: role (.+)\]$/;

/** The request as Blackwing would send it, for a probe that never went out (refused, or not single-delta). */
export function unsentRequest(probe: HttpRequest, credentialHeader?: string): SentRequest {
  const headers: Record<string, string> = Object.fromEntries(Object.entries(probe.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  if (probe.as_role !== undefined && credentialHeader !== undefined) headers[credentialHeader.toLowerCase()] = `[redacted: role ${probe.as_role}]`;
  return { method: probe.method.toUpperCase(), url: probe.url, headers, body: probe.body ?? null, asRole: probe.as_role ?? null };
}

/** A curl of the request as sent. A test account credential becomes `<role credential>`, never its value; then scrubbed. */
export function reproCurl(request: SentRequest): string {
  const parts = ['curl', '-sS', '-i', '-X', request.method.toUpperCase()];
  for (const [name, value] of Object.entries(request.headers)) {
    const role = ROLE_PLACEHOLDER.exec(value)?.[1];
    parts.push('-H', shellQuote(`${name}: ${role === undefined ? value : `<${role} credential>`}`));
  }
  if (request.body !== null) parts.push('--data-raw', shellQuote(request.body));
  parts.push(shellQuote(request.url));
  return scrub(parts.join(' '));
}

/** Where the excerpt starts: some context before the first oracle match, so the evidence is visible, not page chrome. */
function excerptStart(body: string, oracle: Oracle | undefined): number {
  if (oracle === undefined || oracle.type === 'status_equals' || oracle.type === 'header_contains') return 0;
  let at = -1;
  if (oracle.type === 'body_contains') at = body.indexOf(oracle.value);
  else {
    try {
      at = new RegExp(oracle.value).exec(body)?.index ?? -1;
    } catch {
      at = -1;
    }
  }
  return at < 0 ? 0 : Math.max(0, at - EXCERPT_CONTEXT_CHARS);
}

/** One side of the proof: the request as sent and the response, the excerpt scrubbed (around the oracle match), the hash over the raw body. */
export function sideEvidence(response: Sent, oracle?: Oracle): Record<string, unknown> {
  const body = scrub(response.body);
  const start = excerptStart(body, oracle);
  return {
    exchangeId: response.exchangeId,
    request: scrubDeep(response.request),
    response: { status: response.status, bodyExcerpt: `${start > 0 ? '…' : ''}${body.slice(start, start + EXCERPT_CHARS)}`, bodySha256: sha256(response.body) },
  };
}

/** `evidence.remediation` (jsonb, no migration), only when the model gave one; scrubbed. */
export function remediationOf(candidate: Candidate): { remediation?: string } {
  const text = scrub(candidate.remediation?.trim() ?? '');
  return text === '' ? {} : { remediation: text };
}

export interface FindingRowInput {
  readonly run: Pick<HuntRun, 'id' | 'assetId'>;
  readonly candidate: Candidate;
  readonly verdict: Verdict;
  readonly agent: string;
  readonly testCaseId: string | null;
  readonly credentialHeader: string | undefined;
}

/**
 * The finding row for a validated candidate. `proven` rows carry the proof (`evidence.proof`); location and curl come
 * from the probe as actually sent. Every text that may hold target data is scrubbed here, at store time.
 */
export function buildFindingRow(input: FindingRowInput): { proven: boolean; row: Omit<FindingRow, 'id' | 'status'> } {
  const { run, candidate, verdict } = input;
  const { probe, control } = verdict;
  const proven = verdict.confirmed && probe !== null && (control !== null || verdict.delta === 'none');
  const trigger = probe?.request ?? unsentRequest(candidate.probe, input.credentialHeader);
  const identity = identityKey(run.assetId, candidate);
  const description = scrub(candidate.description);
  // A probe refused before it was sent still shows what Blackwing asked for (request only, no response).
  const sides = {
    probe: probe === null ? { request: scrubDeep(trigger) } : sideEvidence(probe, candidate.oracle),
    ...(control === null ? {} : { control: sideEvidence(control, candidate.oracle) }),
  };
  const evidence: Record<string, unknown> = proven
    ? {
        ...sides,
        oracle: candidate.oracle,
        replays: verdict.replays,
        proof: { kind: verdict.delta === 'none' ? 'exposure_replay' : 'differential_replay', replays: verdict.replays.length, delta: verdict.delta, proposedBy: 'claude' },
        description,
        ...remediationOf(candidate),
      }
    : { reason: verdict.reason, replays: verdict.replays, oracle: candidate.oracle, ...remediationOf(candidate), ...sides };
  return {
    proven,
    row: {
      fingerprint: fingerprint(run.id, identity),
      identityKey: identity,
      agent: input.agent,
      title: scrub(candidate.title),
      vulnClass: candidate.vulnClass,
      cwe: candidate.cwe,
      owasp: canonicalOwasp(candidate.owasp) ?? candidate.owasp,
      severity: candidate.severity,
      description,
      location: { method: trigger.method, url: scrub(trigger.url) },
      oracle: candidate.oracle,
      evidence,
      replay: {
        replays: verdict.replays,
        control: control === null ? null : { status: control.status, matched: proven ? false : verdict.controlMatched },
      },
      reproCurl: reproCurl(trigger),
      testCaseId: input.testCaseId,
    },
  };
}

const storedRequestSchema = z.object({
  method: z.string().min(1),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().nullish(),
  asRole: z.string().nullish(),
});
/** Headers the runner sets itself on every send. */
const RUNNER_HEADERS = new Set(['user-agent']);
const REDACTED_MARK = /\[redacted/i;

/**
 * The stored (scrubbed) request as a probe Blackwing may send again: the runner's own headers dropped, the test
 * account credential back to `as_role`. Null when a value Blackwing does not keep is needed (an agent-obtained token).
 */
export function replayableRequest(stored: unknown, roles: readonly string[]): { request: HttpRequest } | { reason: string } {
  const parsed = storedRequestSchema.safeParse(scrubDeep(stored));
  if (!parsed.success) return { reason: 'The finding has no stored request to send again.' };
  const { method, url } = parsed.data;
  const body = parsed.data.body ?? undefined;
  const asRole = parsed.data.asRole ?? undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed.data.headers)) {
    if (RUNNER_HEADERS.has(name.toLowerCase()) || (asRole !== undefined && ROLE_PLACEHOLDER.test(value))) continue;
    headers[name] = value;
  }
  if ([url, body ?? '', ...Object.values(headers)].some((part) => REDACTED_MARK.test(part))) {
    return { reason: 'The request needs a fresh sign-in: it used a value Blackwing does not keep.' };
  }
  if (asRole !== undefined && !roles.some((role) => role.toLowerCase() === asRole.toLowerCase())) {
    return { reason: `The test account ${asRole} is no longer on this audit's plan.` };
  }
  return {
    request: { method, url, ...(Object.keys(headers).length === 0 ? {} : { headers }), ...(body === undefined ? {} : { body }), ...(asRole === undefined ? {} : { as_role: asRole }) },
  };
}

/**
 * Retests one finding: the stored probe is replayed and the stored control sent once, through the normal send rules.
 * `still_present` when it validates again, `fixed` when the probe no longer matches the oracle, else `inconclusive`.
 */
export async function retestFinding(job: RetestJob, send: (request: HttpRequest) => Promise<HttpResult>): Promise<RetestResult> {
  const inconclusive = (reason: string, extra: Record<string, unknown> = {}): RetestResult => ({ status: 'done', result: 'inconclusive', detail: { reason, ...extra } });
  const oracle = oracleSchema.safeParse(job.oracle);
  if (!oracle.success) return inconclusive('The finding has no oracle to check.');
  const roles = job.run.testAccounts.map((a) => a.role);
  const probe = replayableRequest(job.probe, roles);
  if (!('request' in probe)) return inconclusive(probe.reason);
  // Proven without a control (exposure template): the retest replays the probe alone, as the proof did.
  const control = job.control === null || job.control === undefined ? null : replayableRequest(job.control, roles);
  if (control !== null && !('request' in control)) return inconclusive(control.reason);
  const verdict = await validateCandidate({ probe: probe.request, ...(control === null ? { cwe: 'CWE-200' } : { control: control.request }), oracle: oracle.data }, {
    send,
    replay: () => Promise.resolve(),
    control: () => Promise.resolve(),
  });
  const detail = {
    replays: verdict.replays,
    control: verdict.control === null ? null : { status: verdict.control.status, matched: verdict.controlMatched },
  };
  if (verdict.confirmed) return { status: 'done', result: 'still_present', detail: { ...detail, reason: 'Every replay matched the oracle and the control did not.' } };
  if (verdict.replays.length > 0 && verdict.replays.every((r) => !r.matched)) {
    return { status: 'done', result: 'fixed', detail: { ...detail, reason: 'The probe no longer matches the oracle.' } };
  }
  return inconclusive(verdict.reason, detail);
}
