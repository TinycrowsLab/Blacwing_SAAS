import { z } from 'zod';

import {
  formatCidr,
  formatIp,
  LIMITS,
  normaliseHost,
  normaliseIp,
  normalisePath,
  parseCidr,
  parseIp,
  type ScopeTarget,
} from '@blackwing/contracts';

/**
 * Supplied-target canonicalisation for the recon plan (SCOPE-001 manifest, SCOPE-002 scope matcher).
 *
 * A supplied target is canonicalised exactly like the egress gateway sees it, so the scope decision made
 * here is the one enforced downstream. Anything that cannot be canonicalised is refused with a reason
 * (fail closed), never guessed.
 */

const TARGET_KINDS = ['url', 'host', 'cidr'] as const;
type TargetKind = (typeof TARGET_KINDS)[number];

/** A target as the customer supplied it (`{kind, value}`, see `input_manifests.supplied_targets`). */
export const suppliedTargetSchema = z.object({
  kind: z.enum(TARGET_KINDS),
  value: z.string().min(1).max(LIMITS.urlMax),
});
export type SuppliedTarget = z.infer<typeof suppliedTargetSchema>;

/** A target in canonical form. `identity` is the host or IP it names, used for spec-coverage matching. */
export interface CanonicalTarget {
  readonly kind: TargetKind;
  readonly value: string;
  readonly identity: string;
  readonly scope: ScopeTarget;
}

export type TargetCanonicalisation =
  | { readonly ok: true; readonly target: CanonicalTarget }
  | { readonly ok: false; readonly reason: string };

const ADDRESS_BITS = 128;
const DEFAULT_PORT_BY_SCHEME: Readonly<Record<string, number>> = Object.freeze({
  'http:': 80,
  'https:': 443,
});
const BRACKETED_IPV6 = /^\[(.*)\]$/;

const refuse = (reason: string): TargetCanonicalisation => ({ ok: false, reason });

function canonicaliseUrl(value: string): TargetCanonicalisation {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse('malformed url');
  }
  const defaultPort = DEFAULT_PORT_BY_SCHEME[url.protocol];
  if (defaultPort === undefined) return refuse('url scheme must be http or https');
  // A URL that embeds credentials is refused outright; the credential never reaches the plan.
  if (url.username !== '' || url.password !== '') return refuse('url carries credentials');
  const path = normalisePath(url.pathname);
  if (!path.ok) return refuse(`url path ${path.reason}`);
  const port = url.port === '' ? defaultPort : Number(url.port);
  const hostText = url.hostname.replace(BRACKETED_IPV6, '$1');

  const address = parseIp(hostText) === null ? null : normaliseIp(hostText);
  const portPart = port === defaultPort ? '' : `:${port}`;
  if (address !== null) {
    const shown = address.includes(':') ? `[${address}]` : address;
    return {
      ok: true,
      target: {
        kind: 'url',
        value: `${url.protocol}//${shown}${portPart}${path.path}`,
        identity: address,
        scope: { ip: address, port, path: path.path },
      },
    };
  }
  const host = normaliseHost(hostText);
  if (host === null) return refuse('invalid url host');
  return {
    ok: true,
    target: {
      kind: 'url',
      value: `${url.protocol}//${host}${portPart}${path.path}`,
      identity: host,
      scope: { host, port, path: path.path },
    },
  };
}

function canonicaliseHost(value: string): TargetCanonicalisation {
  const host = normaliseHost(value);
  if (host === null) {
    return refuse(
      parseIp(value) === null ? 'invalid host name' : 'ip address: use kind cidr for addresses',
    );
  }
  return { ok: true, target: { kind: 'host', value: host, identity: host, scope: { host } } };
}

function canonicaliseCidr(value: string): TargetCanonicalisation {
  const cidr = parseCidr(value);
  if (cidr === null) return refuse('malformed cidr');
  // Scope rules match one address at a time. A wider range cannot be proven inside a rule set.
  if (cidr.prefix !== ADDRESS_BITS) {
    return refuse('cidr range wider than one address; list the addresses or hosts instead');
  }
  const ip = formatIp(cidr.network);
  return {
    ok: true,
    target: { kind: 'cidr', value: formatCidr(cidr), identity: ip, scope: { ip } },
  };
}

/**
 * The value of a supplied target as it may appear in the plan. A URL keeps scheme, host, port and path only:
 * userinfo, query and fragment never reach the plan or its logs (a credential or token must not be echoed).
 */
export function redactedTargetValue(raw: SuppliedTarget): string {
  if (raw.kind !== 'url') return raw.value;
  try {
    const url = new URL(raw.value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(malformed url)';
  }
}

/** Canonical form of one supplied target, or the reason it was refused. Never throws. */
export function canonicaliseTarget(raw: SuppliedTarget): TargetCanonicalisation {
  if (raw.kind === 'url') return canonicaliseUrl(raw.value);
  if (raw.kind === 'host') return canonicaliseHost(raw.value);
  return canonicaliseCidr(raw.value);
}
