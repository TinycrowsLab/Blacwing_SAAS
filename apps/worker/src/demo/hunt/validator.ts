// Deterministic validator. A finding is `confirmed` only if the probe matches the oracle on all replays and the
// negative control does not. The model proposes candidates; it never decides confirmation.
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { probeSchema, type HttpRequest, type HttpResult } from './http-tool.js';

export const REPLAYS = 3;
const EXCERPT_CHARS = 2000;
const MAX_ORACLE_VALUE_CHARS = 500;
const MAX_TITLE_CHARS = 200;
const MAX_VULN_CLASS_CHARS = 100;
const MAX_CWE_CHARS = 20;
const MAX_OWASP_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_REMEDIATION_CHARS = 1000;

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
  owasp: z.string().min(1).max(MAX_OWASP_CHARS),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  description: z.string().min(1).max(MAX_DESCRIPTION_CHARS),
  /** The model's fix suggestion, shown labelled "not verified". Optional: the console hides the block when absent. */
  remediation: z.string().max(MAX_REMEDIATION_CHARS).optional(),
  probe: probeSchema,
  control: probeSchema,
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

export interface Verdict {
  readonly confirmed: boolean;
  readonly reason: string;
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

/** Replays the probe 3 times, then the control once. Any refusal or failure means not confirmed. */
export async function validateCandidate(candidate: Candidate, hooks: ValidatorHooks): Promise<Verdict> {
  const replays: ReplayRecord[] = [];
  let probe: Sent | null = null;
  for (let n = 1; n <= REPLAYS; n += 1) {
    const result = await hooks.send(candidate.probe);
    if (!result.ok) return { confirmed: false, reason: `probe replay ${n} not sent: ${result.refusal}`, replays, probe, control: null, controlMatched: null };
    probe = result;
    const matched = oracleMatches(candidate.oracle, result);
    replays.push({ n, status: result.status, matched, bodySha256: sha256(result.body) });
    await hooks.replay(n, result.status, matched);
    if (!matched) return { confirmed: false, reason: `probe replay ${n} did not match the oracle`, replays, probe, control: null, controlMatched: null };
  }
  const control = await hooks.send(candidate.control);
  if (!control.ok) return { confirmed: false, reason: `negative control not sent: ${control.refusal}`, replays, probe, control: null, controlMatched: null };
  const controlMatched = oracleMatches(candidate.oracle, control);
  await hooks.control(control.status, controlMatched);
  if (controlMatched) return { confirmed: false, reason: 'the negative control also matched the oracle', replays, probe, control, controlMatched };
  return { confirmed: true, reason: 'all probe replays matched and the negative control did not', replays, probe, control, controlMatched };
}

export function fingerprint(runId: string, candidate: Candidate): string {
  const path = new URL(candidate.probe.url).pathname;
  return sha256([runId, candidate.probe.method.toUpperCase(), path, candidate.vulnClass, candidate.title].join('|'));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A probe sent as a test account gets a placeholder for that credential header, never its value. */
export function reproCurl(probe: HttpRequest, credentialHeader?: string): string {
  const parts = ['curl', '-sS', '-i', '-X', probe.method.toUpperCase()];
  for (const [name, value] of Object.entries(probe.headers ?? {})) parts.push('-H', shellQuote(`${name}: ${value}`));
  if (probe.as_role !== undefined && credentialHeader !== undefined) parts.push('-H', shellQuote(`${credentialHeader}: <${probe.as_role} credential>`));
  if (probe.body !== undefined) parts.push('--data-raw', shellQuote(probe.body));
  parts.push(shellQuote(probe.url));
  return parts.join(' ');
}

export function sideEvidence(request: HttpRequest, response: Sent): Record<string, unknown> {
  return {
    request: { method: request.method.toUpperCase(), url: request.url, headers: request.headers ?? {}, body: request.body ?? null },
    response: { status: response.status, bodyExcerpt: response.body.slice(0, EXCERPT_CHARS), bodySha256: sha256(response.body) },
  };
}

/** Evidence jsonb written with a confirmed finding (see docs/poc/AI_HUNT_POC.md section 3). */
export function buildEvidence(candidate: Candidate, probe: Sent, control: Sent, replays: readonly ReplayRecord[]): Record<string, unknown> {
  return {
    probe: sideEvidence(candidate.probe, probe),
    control: sideEvidence(candidate.control, control),
    oracle: candidate.oracle,
    replays,
    description: candidate.description,
    ...remediationOf(candidate),
  };
}

/** `evidence.remediation` (jsonb, no migration), only when the model gave one. */
export function remediationOf(candidate: Candidate): { remediation?: string } {
  const text = candidate.remediation?.trim() ?? '';
  return text === '' ? {} : { remediation: text };
}
