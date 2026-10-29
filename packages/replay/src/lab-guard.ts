import { normaliseIp, type ScopeRules, type ScopeTarget } from '@blackwing/contracts';
import { matchScope } from '@blackwing/domain';
import { ScopeViolationError, ValidationError } from '@blackwing/errors';

/**
 * Hosts that count as a verified local lab (CONTEXT_PACK §4.5, §8.10). Anything else is refused before a
 * single byte is sent, even when the standing authorisation's scope would otherwise allow it. The demo
 * never targets the public internet.
 */
export const LAB_HOSTS: readonly string[] = Object.freeze([
  '127.0.0.1',
  'localhost',
  'juice.bw.localhost',
]);

const DEFAULT_PORT: Readonly<Record<string, number>> = Object.freeze({
  'http:': 80,
  'https:': 443,
});

/** The explicit port of `url`, or the scheme's default port. */
export function portOf(url: URL): number {
  const fallback = DEFAULT_PORT[url.protocol] ?? 0;
  return url.port === '' ? fallback : Number(url.port);
}

/** Where a URL lands once it has passed the lab guard. */
export interface LabTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * Fail-closed guard: the URL must be http(s) without credentials, on a verified lab host, and in scope under
 * `scope` (the same matcher the egress gateway uses). Throws {@link ScopeViolationError} otherwise. Invalid
 * URLs throw {@link ValidationError}. Never performs I/O.
 */
export function assertLabTarget(rawUrl: string, scope: ScopeRules): LabTarget {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('the target is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ScopeViolationError('the target must be http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ScopeViolationError('the target must not carry credentials');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!LAB_HOSTS.includes(host)) {
    throw new ScopeViolationError('the target is not a verified lab asset');
  }
  const port = portOf(url);
  const ip = normaliseIp(host);
  const target: ScopeTarget = ip === null ? { host, port } : { ip: host, port };
  const decision = matchScope({ ...target, path: url.pathname, method: 'GET' }, scope);
  if (!decision.inScope) {
    throw new ScopeViolationError(`the target is out of scope: ${decision.reason}`);
  }
  return { host, port };
}
