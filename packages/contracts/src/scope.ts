import { domainToASCII } from 'node:url';

import { z } from 'zod';

import { LIMITS } from './limits.js';

/**
 * Canonical scope-rule model (SCOPE-002, §7 `scope_rules`, §8.2 egress fails closed).
 *
 * This file is the single source of truth for the rule shape and its canonical form. The matcher
 * lives in `@blackwing/domain` (`matchScope`), the egress gateway mirrors it in Go (EGRESS-004) and
 * both run the shared vectors in `scope.vectors.json`.
 *
 * Canonical forms (identical in TS and Go):
 * - host: lowercase, IDNA (UTS #46) to ASCII/punycode, one trailing dot removed, RFC 1123 labels.
 *   A rule host may carry one leftmost wildcard label (`*.example.com`) that matches exactly one
 *   label: it matches `a.example.com`, never `example.com` (the apex needs its own rule) and never
 *   `a.b.example.com`. IP literals are not hosts; use `cidr`.
 * - IP/CIDR: parsed strictly (no leading zeros, no zone). IPv4 is held as IPv4-mapped IPv6
 *   (`::ffff:a.b.c.d`), so `10.0.0.1` and `::ffff:10.0.0.1` are the same address. A bare address is
 *   a /32 (/128). Host bits set in a CIDR are rejected. Text form: dotted IPv4 for mapped addresses,
 *   RFC 5952 for IPv6.
 * - path: query/fragment dropped, percent-decoded exactly once (never twice), control characters
 *   rejected, `\` read as `/`, empty and `.` segments dropped, `..` resolved (clamped at the root;
 *   rule paths may not contain `..`), no trailing slash except the root. `%`, `?` and `#` are then
 *   re-encoded (`%25`, `%3F`, `%23`) so the canonical form is idempotent.
 *   Rule globs: `*` matches any run of characters inside one segment; a `**` segment matches zero
 *   or more whole segments (`/api/**` matches `/api` and `/api/a/b`).
 * - method: upper-cased.
 * - ports: a single port or an inclusive `{ from, to }` range, 1-65535.
 */

export const SCOPE_ERROR_CODES = ['SCOPE_INVALID_RULE'] as const;
export type ScopeErrorCode = (typeof SCOPE_ERROR_CODES)[number];

/** Raised for malformed scope rules from untrusted input. */
export class ScopeRuleError extends Error {
  readonly code: ScopeErrorCode;
  readonly issues: readonly string[];

  constructor(code: ScopeErrorCode, message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'ScopeRuleError';
    this.code = code;
    this.issues = issues;
  }
}

/** True when `value` is a `ScopeRuleError` (also across package copies). */
export function isScopeRuleError(value: unknown): value is ScopeRuleError {
  return (
    value instanceof Error &&
    (SCOPE_ERROR_CODES as readonly unknown[]).includes((value as { code?: unknown }).code)
  );
}

export const HTTP_METHODS = [
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'CONNECT',
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Upper bound on rules in one set, so evaluation stays cheap and bounded. */
export const SCOPE_RULES_MAX = 1000;
const SCOPE_LIST_MAX = 100;
const INVALID = 'SCOPE_INVALID_RULE';

// ---------------------------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------------------------

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function asciiHost(raw: string): string | null {
  if (raw.length === 0 || raw.length > LIMITS.hostnameMax + 1 || /[\s/\\:@%[\]]/.test(raw)) {
    return null;
  }
  const trimmed = raw.endsWith('.') ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0 || trimmed.includes('*')) return null;
  const ascii = domainToASCII(trimmed.toLowerCase());
  if (ascii.length === 0 || ascii.length > LIMITS.hostnameMax) return null;
  const labels = ascii.split('.');
  if (!labels.every((label) => LABEL.test(label))) return null;
  // A numeric last label would make this an IP literal (or an ambiguous one); IPs belong in `cidr`.
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? '')) return null;
  return ascii;
}

/** Canonical form of a target hostname, or `null` when it is not a valid DNS name. */
export function normaliseHost(raw: string): string | null {
  return asciiHost(raw);
}

/**
 * Canonical form of a rule host pattern (exact or `*.` wildcard), or `null` when malformed.
 * A wildcard needs at least two labels after it (`*.com` is rejected).
 */
export function normaliseHostPattern(raw: string): string | null {
  if (raw.startsWith('*.')) {
    const suffix = asciiHost(raw.slice(2));
    if (!suffix?.includes('.')) return null;
    return `*.${suffix}`;
  }
  return asciiHost(raw);
}

// ---------------------------------------------------------------------------------------------
// IP addresses and CIDRs (128-bit, IPv4 mapped into ::ffff:0:0/96)
// ---------------------------------------------------------------------------------------------

const ZERO = BigInt(0);
const ONE = BigInt(1);
const ADDRESS_BITS = 128;
const V4_BITS = 32;
/** Prefix offset of the IPv4-mapped range `::ffff:0:0/96`. */
const V4_MAPPED_BITS = ADDRESS_BITS - V4_BITS;
const GROUP_COUNT = 8;
const GROUP_BITS = 16;
const OCTET_BITS = 8;
const HEX_RADIX = 16;
const GROUP_MASK = (ONE << BigInt(GROUP_BITS)) - ONE;
const OCTET_MASK = (ONE << BigInt(OCTET_BITS)) - ONE;
const V4_MASK = (ONE << BigInt(V4_BITS)) - ONE;
const V4_MAPPED_TAG = GROUP_MASK;
const V4_MAPPED_PREFIX = V4_MAPPED_TAG << BigInt(V4_BITS);
const MAX_128 = (ONE << BigInt(ADDRESS_BITS)) - ONE;
/** Longest textual IPv6 address (with an embedded IPv4 tail). */
const V6_TEXT_MAX = 45;
const CIDR_TEXT_MAX = 64;
const V4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const V4 = new RegExp(`^${V4_OCTET}(?:\\.${V4_OCTET}){3}$`);

function prefixMask(prefix: number): bigint {
  return prefix === 0 ? ZERO : (MAX_128 << BigInt(ADDRESS_BITS - prefix)) & MAX_128;
}

function parseV4(raw: string): bigint | null {
  if (!V4.test(raw)) return null;
  return raw.split('.').reduce((acc, octet) => (acc << BigInt(OCTET_BITS)) | BigInt(octet), ZERO);
}

function parseGroups(part: string): bigint[] | null {
  if (part === '') return [];
  const groups: bigint[] = [];
  const pieces = part.split(':');
  for (const [i, piece] of pieces.entries()) {
    if (i === pieces.length - 1 && piece.includes('.')) {
      const v4 = parseV4(piece);
      if (v4 === null) return null;
      groups.push(v4 >> BigInt(GROUP_BITS), v4 & GROUP_MASK);
    } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
      groups.push(BigInt(Number.parseInt(piece, HEX_RADIX)));
    } else {
      return null;
    }
  }
  return groups;
}

function parseV6(raw: string): bigint | null {
  if (raw.length > V6_TEXT_MAX || raw.includes('%')) return null;
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  let groups: bigint[];
  if (halves.length === 2) {
    const [headText = '', tailText = ''] = halves;
    // An embedded IPv4 may only appear in the last position.
    if (headText.includes('.')) return null;
    const head = parseGroups(headText);
    const tail = parseGroups(tailText);
    if (head === null || tail === null || head.length + tail.length >= GROUP_COUNT) return null;
    const zeros = Array.from({ length: GROUP_COUNT - head.length - tail.length }, () => ZERO);
    groups = [...head, ...zeros, ...tail];
  } else {
    const all = parseGroups(raw);
    if (all?.length !== GROUP_COUNT) return null;
    groups = all;
  }
  return groups.reduce((acc, group) => (acc << BigInt(GROUP_BITS)) | group, ZERO);
}

/**
 * Parses an IPv4 or IPv6 address into its 128-bit value (IPv4 as IPv4-mapped IPv6), or `null`.
 */
export function parseIp(raw: string): bigint | null {
  const v4 = parseV4(raw);
  if (v4 !== null) return V4_MAPPED_PREFIX | v4;
  return raw.includes(':') ? parseV6(raw) : null;
}

function isV4Mapped(value: bigint): boolean {
  return value >> BigInt(V4_BITS) === V4_MAPPED_TAG;
}

function formatV4(value: bigint): string {
  const octets: string[] = [];
  for (let shift = V4_BITS - OCTET_BITS; shift >= 0; shift -= OCTET_BITS) {
    octets.push(String((value >> BigInt(shift)) & OCTET_MASK));
  }
  return octets.join('.');
}

function formatV6(value: bigint): string {
  const groups: number[] = [];
  for (let shift = ADDRESS_BITS - GROUP_BITS; shift >= 0; shift -= GROUP_BITS) {
    groups.push(Number((value >> BigInt(shift)) & GROUP_MASK));
  }
  // RFC 5952: compress the longest run (>= 2) of zero groups, the first one on a tie.
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < GROUP_COUNT) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < GROUP_COUNT && groups[j] === 0) j += 1;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(HEX_RADIX));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/** Canonical text of a 128-bit address: dotted IPv4 when IPv4-mapped, RFC 5952 otherwise. */
export function formatIp(value: bigint): string {
  return isV4Mapped(value) ? formatV4(value & V4_MASK) : formatV6(value);
}

/** Canonical form of an IP address, or `null` when malformed. */
export function normaliseIp(raw: string): string | null {
  const value = parseIp(raw);
  return value === null ? null : formatIp(value);
}

/** A parsed CIDR in the 128-bit space. */
export interface Cidr {
  readonly network: bigint;
  /** Prefix length in the 128-bit space (an IPv4 `/8` is `/104`). */
  readonly prefix: number;
}

/** Parses a CIDR (or bare address) strictly; host bits set, bad prefixes and zones are rejected. */
export function parseCidr(raw: string): Cidr | null {
  if (raw.length > CIDR_TEXT_MAX) return null;
  const slash = raw.indexOf('/');
  const addrText = slash < 0 ? raw : raw.slice(0, slash);
  const prefixText = slash < 0 ? null : raw.slice(slash + 1);
  const isV4 = parseV4(addrText) !== null;
  const address = parseIp(addrText);
  if (address === null) return null;
  const maxPrefix = isV4 ? V4_BITS : ADDRESS_BITS;
  let prefix = maxPrefix;
  if (prefixText !== null) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(prefixText)) return null;
    prefix = Number(prefixText);
    if (prefix > maxPrefix) return null;
  }
  const prefix128 = isV4 ? prefix + V4_MAPPED_BITS : prefix;
  if ((address & prefixMask(prefix128)) !== address) return null;
  return { network: address, prefix: prefix128 };
}

/** Canonical text of a CIDR: `a.b.c.d/n` inside the IPv4-mapped range, RFC 5952 `/n` otherwise. */
export function formatCidr(cidr: Cidr): string {
  if (cidr.prefix >= V4_MAPPED_BITS && isV4Mapped(cidr.network)) {
    return `${formatV4(cidr.network & V4_MASK)}/${cidr.prefix - V4_MAPPED_BITS}`;
  }
  return `${formatV6(cidr.network)}/${cidr.prefix}`;
}

/** True when the 128-bit `address` lies inside `cidr`. */
export function cidrContains(cidr: Cidr, address: bigint): boolean {
  return (address & prefixMask(cidr.prefix)) === cidr.network;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** Canonical path result: the path or why it was rejected. */
export type PathNormalisation =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/**
 * Canonical form of a request or rule path (see the module docs). `allowDotDot: false` (rules)
 * rejects any `..` segment instead of resolving it.
 */
export function normalisePath(
  raw: string,
  options: { allowDotDot?: boolean } = {},
): PathNormalisation {
  const allowDotDot = options.allowDotDot ?? true;
  if (raw.length === 0 || raw.length > LIMITS.urlMax) return { ok: false, reason: 'path length' };
  const cut = raw.search(/[?#]/);
  const bare = cut < 0 ? raw : raw.slice(0, cut);
  if (!bare.startsWith('/')) return { ok: false, reason: 'path must start with /' };
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return { ok: false, reason: 'malformed percent-encoding' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded))
    return { ok: false, reason: 'control character in path' };
  const segments: string[] = [];
  for (const segment of decoded.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!allowDotDot) return { ok: false, reason: 'dot-dot segment in rule path' };
      segments.pop();
      continue;
    }
    segments.push(segment.replaceAll('%', '%25').replaceAll('?', '%3F').replaceAll('#', '%23'));
  }
  return { ok: true, path: `/${segments.join('/')}` };
}

// ---------------------------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------------------------

const hostPatternSchema = z
  .string()
  .max(LIMITS.hostnameMax + 2)
  .transform((raw, ctx) => {
    const host = normaliseHostPattern(raw);
    if (host === null) {
      ctx.addIssue({ code: 'custom', message: INVALID });
      return z.NEVER;
    }
    return host;
  });

const cidrSchema = z
  .string()
  .max(CIDR_TEXT_MAX)
  .transform((raw, ctx) => {
    const cidr = parseCidr(raw);
    if (cidr === null) {
      ctx.addIssue({ code: 'custom', message: INVALID });
      return z.NEVER;
    }
    return formatCidr(cidr);
  });

const portSchema = z
  .int({ error: () => INVALID })
  .min(1, INVALID)
  .max(LIMITS.portMax, INVALID);

/** A single port or an inclusive range; a one-port range is canonicalised to the single port. */
export const portSpecSchema = z
  .union([portSchema, z.strictObject({ from: portSchema, to: portSchema })], {
    error: () => INVALID,
  })
  .transform((spec, ctx) => {
    if (typeof spec === 'number') return spec;
    if (spec.from > spec.to) {
      ctx.addIssue({ code: 'custom', message: INVALID });
      return z.NEVER;
    }
    return spec.from === spec.to ? spec.from : spec;
  });
export type PortSpec = z.infer<typeof portSpecSchema>;

const rulePathSchema = z
  .string()
  .max(LIMITS.urlMax)
  .transform((raw, ctx) => {
    const result = normalisePath(raw, { allowDotDot: false });
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: INVALID });
      return z.NEVER;
    }
    return result.path;
  });

export const httpMethodSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.toUpperCase() : value),
  z.enum(HTTP_METHODS, { error: () => INVALID }),
);

/** One ordered include/exclude rule. Every set dimension must match; an unset one matches all. */
export const scopeRuleSchema = z
  .strictObject({
    effect: z.enum(['include', 'exclude'], { error: () => INVALID }),
    host: hostPatternSchema.optional(),
    cidr: cidrSchema.optional(),
    ports: z.array(portSpecSchema).min(1, INVALID).max(SCOPE_LIST_MAX, INVALID).optional(),
    paths: z.array(rulePathSchema).min(1, INVALID).max(SCOPE_LIST_MAX, INVALID).optional(),
    methods: z.array(httpMethodSchema).min(1, INVALID).max(SCOPE_LIST_MAX, INVALID).optional(),
  })
  .superRefine((rule, ctx) => {
    // An include must name an address, or it would bring every host on the internet into scope.
    if (rule.effect === 'include' && rule.host === undefined && rule.cidr === undefined) {
      ctx.addIssue({ code: 'custom', message: INVALID, path: ['host'] });
    }
    const constrained = [rule.host, rule.cidr, rule.ports, rule.paths, rule.methods].some(
      (v) => v !== undefined,
    );
    if (!constrained) ctx.addIssue({ code: 'custom', message: INVALID });
  });
export type ScopeRule = z.output<typeof scopeRuleSchema>;
export type ScopeRuleInput = z.input<typeof scopeRuleSchema>;

/** An ordered rule set, evaluated with default-deny. An empty set puts nothing in scope. */
export const scopeRulesSchema = z.strictObject({
  rules: z.array(scopeRuleSchema).max(SCOPE_RULES_MAX, INVALID),
});
export type ScopeRules = z.output<typeof scopeRulesSchema>;
export type ScopeRulesInput = z.input<typeof scopeRulesSchema>;

/**
 * Parses and canonicalises a rule set from untrusted input.
 * @throws {ScopeRuleError} `SCOPE_INVALID_RULE` naming the offending paths.
 */
export function parseScopeRules(input: unknown): ScopeRules {
  const result = scopeRulesSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
    throw new ScopeRuleError(INVALID, `invalid scope rules at ${issues.join(', ')}`, issues);
  }
  return result.data;
}

/** A concrete request target. Every field is optional; missing ones are treated conservatively. */
export const scopeTargetSchema = z.strictObject({
  host: z.string().optional(),
  ip: z.string().optional(),
  port: z.number().optional(),
  path: z.string().optional(),
  method: z.string().optional(),
});
export type ScopeTarget = z.infer<typeof scopeTargetSchema>;

/** Result of `matchScope`; `reason` is safe to log (no query strings, no secrets). */
export interface ScopeDecision {
  readonly inScope: boolean;
  readonly matchedRule?: ScopeRule;
  /** Index of `matchedRule` in the rule set. */
  readonly matchedRuleIndex?: number;
  readonly reason: string;
}
