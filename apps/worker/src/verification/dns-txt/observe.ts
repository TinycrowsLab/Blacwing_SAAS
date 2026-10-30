import { capDnsTxtValues, matchesDnsTxt } from '@blackwing/domain';

import type { DnsResolver } from './resolver.js';

/**
 * One DNS TXT observation of a challenge location (ASSET-005). Resolution happens here, in the worker, and only for
 * proof: the answer is compared to the token and the observed values are kept for the challenge record.
 */

export interface DnsTxtObservation {
  /** Whether one observed TXT value is the challenge token. */
  readonly matched: boolean;
  /** The TXT values that were considered (capped at `maxRecords`). Never logged with the token. */
  readonly observedValues: readonly string[];
  /** Whether the TXT set was larger than `maxRecords` and the rest was not considered. */
  readonly truncated: boolean;
  /** The name followed by each CNAME target, in order. A name with no CNAME is a chain of one. */
  readonly chain: readonly string[];
  /** The upstream resolvers the answer came from (`bw.asset.dns` pinned set). */
  readonly resolver: string;
  readonly elapsedMs: number;
}

/**
 * Every retry of a resolver failure (SERVFAIL, timeout, refused) was spent. Retryable by design: the activity fails
 * with this error, Temporal retries it, and the challenge is not failed on a resolver outage (issue ASSET-005).
 */
export class DnsResolverUnavailableError extends Error {
  readonly code: string;

  constructor(code: string) {
    // The location is not in the message: the error is logged, and the challenge already holds the location.
    super(`DNS lookup of the verification name is unavailable (${code})`);
    this.name = 'DnsResolverUnavailableError';
    this.code = code;
  }
}

/** Answers that are definitive: the name or its records do not exist. They are a miss, never a retry. */
const DEFINITIVE_MISS = new Set(['ENOTFOUND', 'ENODATA']);
/** Longest CNAME chain recorded; a longer chain is cut, and it is never followed forever. */
const MAX_CHAIN_HOPS = 8;

export interface ObserveDnsTxtInput {
  /** The challenge location, e.g. `_blackwing-challenge.example.com` (already the A-label). */
  readonly name: string;
  /** The full record value the owner must publish (`blackwing-site-verification=<token>`). */
  readonly token: string;
  readonly resolver: DnsResolver;
  /** The pinned upstreams, joined for the record. */
  readonly resolverLabel: string;
  readonly settings: { readonly retries: number; readonly maxRecords: number };
  /** A monotonic clock in milliseconds. Injected so elapsed time is testable. */
  readonly now?: () => number;
  /** Temporal cancellation: checked before every attempt and every chain hop. */
  readonly signal?: AbortSignal;
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

/** A definitive miss resolves to no answers; any other failure propagates to the retry loop. */
async function answersOrMiss<T>(query: () => Promise<T[]>): Promise<T[]> {
  try {
    return await query();
  } catch (error) {
    if (DEFINITIVE_MISS.has(codeOf(error))) return [];
    throw error;
  }
}

/** The CNAME chain of `name`, one hop at a time, stopping at a non-alias, a loop or the hop cap. */
async function walkChain(
  resolver: DnsResolver,
  name: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const chain = [name];
  const seen = new Set([name.toLowerCase()]);
  let current = name;
  for (let hop = 0; hop < MAX_CHAIN_HOPS; hop++) {
    signal?.throwIfAborted();
    const [next] = await answersOrMiss(() => resolver.resolveCname(current));
    if (next === undefined || seen.has(next.toLowerCase())) break;
    chain.push(next);
    seen.add(next.toLowerCase());
    current = next;
  }
  return chain;
}

/**
 * Observes the challenge location once: the chain, then the TXT set. Resolver failures are retried up to
 * `settings.retries` times; when every attempt failed the call throws `DnsResolverUnavailableError`. A definitive
 * NXDOMAIN or an empty TXT set is a clean answer (`matched: false`), never a retry.
 */
export async function observeDnsTxt(input: ObserveDnsTxtInput): Promise<DnsTxtObservation> {
  const now = input.now ?? ((): number => performance.now());
  const started = now();
  const attempts = input.settings.retries + 1;
  let lastCode = 'UNKNOWN';

  for (let attempt = 0; attempt < attempts; attempt++) {
    input.signal?.throwIfAborted();
    try {
      const chain = await walkChain(input.resolver, input.name, input.signal);
      const records = await answersOrMiss(() => input.resolver.resolveTxt(input.name));
      const values = records.map((chunks) => chunks.join(''));
      const capped = capDnsTxtValues(values, input.settings.maxRecords);
      return {
        matched: matchesDnsTxt(input.token, capped.values),
        observedValues: capped.values,
        truncated: capped.truncated,
        chain,
        resolver: input.resolverLabel,
        elapsedMs: Math.max(0, Math.round(now() - started)),
      };
    } catch (error) {
      // A cancelled lookup is not a resolver outage: it ends the observation at once.
      input.signal?.throwIfAborted();
      lastCode = codeOf(error);
    }
  }
  throw new DnsResolverUnavailableError(lastCode);
}
