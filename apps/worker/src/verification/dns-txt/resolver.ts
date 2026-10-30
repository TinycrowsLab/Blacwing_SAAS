import { Resolver } from 'node:dns/promises';

/**
 * The DNS queries the TXT probe makes. Only the two record types it reads are exposed, so a probe cannot be used
 * to resolve anything else. Each call rejects with the Node `code` of the failure (`ENOTFOUND`, `ENODATA`,
 * `ETIMEOUT`, `ESERVFAIL`, ...).
 */
export interface DnsResolver {
  /** TXT values of `name`, one entry per record; each record is its character-strings in order. */
  resolveTxt(name: string): Promise<string[][]>;
  /** CNAME targets of `name`. */
  resolveCname(name: string): Promise<string[]>;
}

interface PinnedResolverOptions {
  /** Trusted upstream resolvers (`ip` or `ip:port`), from config. Queries go only to these. */
  readonly servers: readonly string[];
  /** Per-query timeout in milliseconds (`bw.asset.dns.timeoutMs`). */
  readonly timeoutMs: number;
}

/**
 * A resolver pinned to the configured upstreams, with no system resolver fallback. One query per call: retries
 * belong to the probe, which counts them and turns exhausted failures into a retryable error.
 */
export function createPinnedDnsResolver(options: PinnedResolverOptions): DnsResolver {
  const resolver = new Resolver({ timeout: options.timeoutMs, tries: 1 });
  resolver.setServers([...options.servers]);
  return {
    resolveTxt: (name) => resolver.resolveTxt(name),
    resolveCname: (name) => resolver.resolveCname(name),
  };
}
