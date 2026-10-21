import { AppError } from '@blackwing/errors';

import { TENANT_ID } from './kek.js';

/**
 * Per-run redaction registry (SECRETS-007, §4.3, §8.7): the set of secret values in use by one run,
 * and a matcher that replaces them (and their common encodings) in tool output and model-bound text.
 *
 * Fingerprint-vs-literal tradeoff: exact replacement needs the literal, so each registered value is
 * held in process memory only, for the run's lifetime, and is never written to disk, Valkey, logs,
 * metrics, audit events or error messages. Only metadata (label, counts) leaves memory.
 *
 * Consumer contract (RUNTIME PostToolUse hook, GATEWAY): redaction must fail closed. When the
 * registry cannot be reached or throws, use {@link redactFailClosed}: the text is withheld, never
 * passed through. A purged or unknown run matches nothing, so a consumer must not treat "no hits"
 * as proof the run is registered; it can check {@link RedactionRegistry.has}.
 *
 * Encodings covered: raw, base64 and base64url (padded and unpadded), URL-encoded (upper and lower
 * hex), JSON-string-escaped, and hex. Limits: a value split by the producer (inserted whitespace,
 * case change, partial encoding of a substring, double encoding) is not recognised.
 */

const ID = TENANT_ID;
/** Values shorter than this, or with less than {@link MIN_ENTROPY} bits per char, are not redacted globally. */
const MIN_LENGTH = 8;
const MIN_ENTROPY = 2;
const DEFAULT_GRACE_MS = 60_000;
/** Redacting more than this in one call truncates; larger output goes through a stream. */
const KIB = 1024;
const DEFAULT_MAX_SCAN_MIB = 4;
const DEFAULT_MAX_SCAN = DEFAULT_MAX_SCAN_MIB * KIB * KIB;

export type RedactionAuditAction =
  'secret.redaction_registry_created' | 'secret.redaction_registry_purged';

/** §8.8 audit event: counts only, never values. */
export interface RedactionAuditEvent {
  readonly tenantId: string;
  readonly runId: string;
  readonly action: RedactionAuditAction;
  readonly metadata: { readonly values: number; readonly hits: number };
}

export interface RedactionMetrics {
  /** `redaction_registry_size{runId}` (sampled on register/remove/purge). */
  size(runId: string, size: number): void;
  /** `redaction_hits_total{runId}` */
  hits(runId: string, count: number): void;
  /** `redaction_consumer_failclosed_total` */
  failClosed(): void;
}

export interface RedactionRegistryDeps {
  readonly audit: (event: RedactionAuditEvent) => Promise<void>;
  readonly metrics?: RedactionMetrics;
  /** Wraps redaction in the `secret.redact` span. */
  readonly span?: <T>(name: string, fn: () => T) => T;
  readonly now?: () => number;
  /** How long a rotated-out value keeps being redacted. */
  readonly graceMs?: number;
  readonly maxScanChars?: number;
}

export interface RegisterInput {
  /** Appears in the replacement, `***REDACTED:{label}***`; a short slug. */
  readonly label: string;
  readonly value: string;
  /** Registered tokens redact regardless of the length/entropy threshold. */
  readonly highValue?: boolean;
}

export interface RedactResult {
  readonly text: string;
  /** Number of replacements made. */
  readonly hits: number;
  /** True when the input exceeded the scan cap and the rest was dropped. */
  readonly truncated: boolean;
}

export interface RedactionStream {
  /** Returns text that is safe to emit; a possible secret prefix at the end is held back. */
  push(chunk: string): string;
  /** Emits what remains at end of stream. */
  flush(): string;
}

export interface RedactionRegistry {
  register(
    tenantId: string,
    runId: string,
    input: RegisterInput,
  ): Promise<{ registered: boolean; reason?: 'too-short' | 'low-entropy' }>;
  /** Replaces the value behind `label`; the old value is still redacted until the grace period ends. */
  rotate(tenantId: string, runId: string, input: RegisterInput): Promise<{ registered: boolean }>;
  /** Stops redacting `label` immediately. */
  remove(tenantId: string, runId: string, label: string): void;
  redact(tenantId: string, runId: string, text: string): RedactResult;
  createStream(tenantId: string, runId: string): RedactionStream;
  has(tenantId: string, runId: string): boolean;
  size(tenantId: string, runId: string): number;
  /** Run reached `completed|killed|failed`, or was killed: drops every literal. Idempotent. */
  purge(tenantId: string, runId: string): Promise<void>;
  onRunState(tenantId: string, runId: string, state: string): Promise<void>;
}

interface Entry {
  readonly label: string;
  readonly forms: readonly string[];
  /** Absolute ms after which the entry no longer redacts; undefined while current. */
  expiresAt?: number;
}

interface Matcher {
  readonly regex: RegExp;
  readonly labels: ReadonlyMap<string, string>;
  readonly maxLen: number;
  /** Earliest entry expiry, so a stale matcher is rebuilt. */
  readonly validUntil: number;
}

interface RunRegistry {
  entries: Entry[];
  matcher: Matcher | undefined;
  hits: number;
}

const TERMINAL_STATES = new Set(['completed', 'killed', 'failed']);

/** Redis-style key; used only to scope the in-memory map (never a storage key for literals). */
const registryKey = (tenantId: string, runId: string): string => {
  if (
    typeof tenantId !== 'string' ||
    !ID.test(tenantId) ||
    typeof runId !== 'string' ||
    !ID.test(runId)
  ) {
    throw new AppError('VALIDATION_FAILED', 'invalid tenant or run id for a redaction registry');
  }
  return `bw:${tenantId}:run:${runId}:redaction`;
};

const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function shannonBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = Array.from(value).length;
  let bits = 0;
  for (const c of counts.values()) bits -= (c / n) * Math.log2(c / n);
  return bits;
}

/** Every distinct, non-empty rendering of `value` that the matcher recognises. */
function encodingsOf(value: string): string[] {
  const buf = Buffer.from(value, 'utf8');
  const b64 = buf.toString('base64');
  const b64url = buf.toString('base64url');
  const url = encodeURIComponent(value);
  const json = JSON.stringify(value).slice(1, -1);
  const forms = [
    value,
    b64,
    b64.replace(/=+$/, ''),
    b64url,
    b64url.replace(/=+$/, ''),
    url,
    url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    json,
    buf.toString('hex'),
    buf.toString('hex').toUpperCase(),
  ];
  return [...new Set(forms)].filter((f) => f.length > 0);
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const replacementFor = (label: string): string => `***REDACTED:${label}***`;

export function createRedactionRegistry(deps: RedactionRegistryDeps): RedactionRegistry {
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS;
  const maxScan = deps.maxScanChars ?? DEFAULT_MAX_SCAN;
  const span = deps.span ?? (<T>(_n: string, fn: () => T): T => fn());
  const runs = new Map<string, RunRegistry>();

  const live = (r: RunRegistry): Entry[] => {
    const t = now();
    return r.entries.filter((e) => e.expiresAt === undefined || e.expiresAt > t);
  };

  function matcherOf(r: RunRegistry): Matcher | undefined {
    if (r.matcher !== undefined && r.matcher.validUntil > now()) return r.matcher;
    const entries = live(r);
    r.entries = entries;
    const labels = new Map<string, string>();
    for (const e of entries) {
      for (const f of e.forms) if (!labels.has(f)) labels.set(f, replacementFor(e.label));
    }
    if (labels.size === 0) {
      r.matcher = undefined;
      return undefined;
    }
    // Longest first, so an encoding that contains a shorter form wins.
    const forms = [...labels.keys()].sort((a, b) => b.length - a.length);
    r.matcher = {
      regex: new RegExp(forms.map((f) => escapeRegex(f)).join('|'), 'g'),
      labels,
      maxLen: forms[0]?.length ?? 0,
      validUntil: Math.min(
        Number.POSITIVE_INFINITY,
        ...entries.map((e) => e.expiresAt ?? Number.POSITIVE_INFINITY),
      ),
    };
    return r.matcher;
  }

  /** Redacts every match that starts before `limit`; returns the output and how much input was consumed. */
  function scan(
    r: RunRegistry,
    text: string,
    limit: number,
  ): { out: string; consumed: number; hits: number } {
    const m = matcherOf(r);
    if (m === undefined)
      return { out: text.slice(0, limit), consumed: Math.min(limit, text.length), hits: 0 };
    let out = '';
    let pos = 0;
    let hits = 0;
    for (const match of text.matchAll(m.regex)) {
      if (match.index >= limit) break;
      out += text.slice(pos, match.index) + (m.labels.get(match[0]) ?? replacementFor('secret'));
      pos = match.index + match[0].length;
      hits += 1;
    }
    // A match that straddles `limit` was consumed whole, so `pos` can pass it.
    const consumed = Math.max(pos, Math.min(limit, text.length));
    out += text.slice(pos, consumed);
    return { out, consumed, hits };
  }

  const count = (runId: string, r: RunRegistry, hits: number): void => {
    if (hits === 0) return;
    r.hits += hits;
    deps.metrics?.hits(runId, hits);
  };

  async function add(tenantId: string, runId: string, input: RegisterInput, rotating: boolean) {
    const key = registryKey(tenantId, runId);
    if (typeof input.label !== 'string' || !LABEL.test(input.label)) {
      throw new AppError('VALIDATION_FAILED', 'invalid redaction label');
    }
    if (typeof input.value !== 'string') {
      throw new AppError('VALIDATION_FAILED', 'redaction value must be a string');
    }
    const value = input.value;
    let reason: 'too-short' | 'low-entropy' | undefined;
    if (input.highValue !== true) {
      if (Array.from(value).length < MIN_LENGTH) reason = 'too-short';
      else if (shannonBitsPerChar(value) < MIN_ENTROPY) reason = 'low-entropy';
    }
    if (value.length === 0) reason = 'too-short';
    if (reason !== undefined) return { registered: false as const, reason };

    let r = runs.get(key);
    const created = r === undefined;
    if (r === undefined) {
      r = { entries: [], matcher: undefined, hits: 0 };
      runs.set(key, r);
    }
    if (rotating) {
      const expiresAt = now() + graceMs;
      for (const e of r.entries) {
        if (e.label === input.label && e.expiresAt === undefined) e.expiresAt = expiresAt;
      }
    } else {
      r.entries = r.entries.filter((e) => e.label !== input.label || e.expiresAt !== undefined);
    }
    r.entries.push({ label: input.label, forms: encodingsOf(value) });
    r.matcher = undefined;
    deps.metrics?.size(runId, live(r).length);
    if (created) {
      try {
        await deps.audit({
          tenantId,
          runId,
          action: 'secret.redaction_registry_created',
          metadata: { values: 1, hits: 0 },
        });
      } catch (err) {
        // An unaudited registry must not exist; drop the literal again.
        runs.delete(key);
        throw err;
      }
    }
    return { registered: true as const };
  }

  function getRun(tenantId: string, runId: string): RunRegistry | undefined {
    return runs.get(registryKey(tenantId, runId));
  }

  return {
    register: (t, r, input) => add(t, r, input, false),
    rotate: (t, r, input) => add(t, r, input, true),
    remove(tenantId, runId, label) {
      const r = getRun(tenantId, runId);
      if (r === undefined) return;
      r.entries = r.entries.filter((e) => e.label !== label);
      r.matcher = undefined;
      deps.metrics?.size(runId, live(r).length);
    },
    redact(tenantId, runId, text) {
      const r = getRun(tenantId, runId);
      return span('secret.redact', () => {
        if (r === undefined) return { text, hits: 0, truncated: false };
        const truncated = text.length > maxScan;
        // A match straddling the cap is consumed whole, so a secret is never half-emitted at the cut.
        const res = scan(r, text, truncated ? maxScan : text.length);
        count(runId, r, res.hits);
        return {
          text: truncated ? `${res.out}***TRUNCATED***` : res.out,
          hits: res.hits,
          truncated,
        };
      });
    },
    createStream(tenantId, runId) {
      const r = getRun(tenantId, runId);
      let pending = '';
      return {
        push(chunk) {
          if (r === undefined) return chunk;
          pending += chunk;
          const m = matcherOf(r);
          if (m === undefined) {
            const out = pending;
            pending = '';
            return out;
          }
          const res = scan(r, pending, Math.max(0, pending.length - (m.maxLen - 1)));
          count(runId, r, res.hits);
          pending = pending.slice(res.consumed);
          return res.out;
        },
        flush() {
          if (r === undefined) return pending;
          const res = scan(r, pending, pending.length);
          count(runId, r, res.hits);
          pending = '';
          return res.out;
        },
      };
    },
    has: (t, r) => runs.has(registryKey(t, r)),
    size(tenantId, runId) {
      const r = getRun(tenantId, runId);
      return r === undefined ? 0 : live(r).length;
    },
    async purge(tenantId, runId) {
      const key = registryKey(tenantId, runId);
      const r = runs.get(key);
      if (r === undefined) return;
      const values = live(r).length;
      // Drop the literals first: a failing audit sink must not keep secrets in memory.
      runs.delete(key);
      deps.metrics?.size(runId, 0);
      await deps.audit({
        tenantId,
        runId,
        action: 'secret.redaction_registry_purged',
        metadata: { values, hits: r.hits },
      });
    },
    onRunState(tenantId, runId, state) {
      return TERMINAL_STATES.has(state) ? this.purge(tenantId, runId) : Promise.resolve();
    },
  };
}

/**
 * The fail-closed wrapper consumers use: if the registry cannot be consulted, withhold the text.
 * `redactFn` may throw or the registry may not know the run (`registered === false`).
 */
export function redactFailClosed(
  redactFn: () => RedactResult,
  metrics?: Pick<RedactionMetrics, 'failClosed'>,
): RedactResult {
  try {
    return redactFn();
  } catch {
    metrics?.failClosed();
    return { text: '***WITHHELD:redaction-unavailable***', hits: 0, truncated: true };
  }
}
