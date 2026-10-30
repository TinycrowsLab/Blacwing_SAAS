import { z } from 'zod';

import { normaliseHost, normaliseIp } from '@blackwing/contracts';

/** One resolved name from `dnsx -json`: canonical host and its canonical A/AAAA answers, in answer order. */
export interface DnsxRecord {
  readonly host: string;
  readonly ips: readonly string[];
}

/** One open TCP port from `naabu -json`: canonical IP and port. */
export interface NaabuResult {
  readonly ip: string;
  readonly port: number;
  readonly proto: 'tcp' | 'udp';
}

/** One probed URL from `httpx -json`: status, title, server and technology signals. Headers and cookies are never read. */
export interface HttpxRecord {
  readonly url: string;
  readonly status: number | null;
  readonly title: string | null;
  readonly webserver: string | null;
  readonly tech: readonly string[];
}

/**
 * One fingerprinted service from `fingerprintx --json`: the canonical IP and port, the protocol fingerprintx
 * identified, and the product and version it could read from the banner (both `null` when not disclosed).
 */
export interface FingerprintxResult {
  readonly ip: string;
  readonly port: number;
  readonly protocol: string;
  readonly product: string | null;
  readonly version: string | null;
}

export interface Parsed<T> {
  readonly records: readonly T[];
  /** Lines that were not valid JSON or did not match the expected shape; never echoed (tool output is untrusted). */
  readonly malformed: number;
}

const PORT_MAX = 65_535;
const PROTOCOL = /^[a-z][a-z0-9_-]{0,63}$/;
const PRODUCT = /^[A-Za-z0-9][A-Za-z0-9 ._+()/-]{0,127}$/;
const PRODUCT_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+:_~-]{0,63}$/;
const URL_MAX = 2048;
const TEXT_MAX = 256;
const TECH_MAX = 128;
const TECH_PER_ROW_MAX = 32;

const httpxLineSchema = z.looseObject({
  url: z.string(),
  status_code: z.number().int().optional(),
  title: z.string().optional(),
  webserver: z.string().optional(),
  tech: z.array(z.string()).optional(),
  failed: z.boolean().optional(),
});

const dnsxLineSchema = z.object({
  host: z.string(),
  a: z.array(z.string()).optional(),
  aaaa: z.array(z.string()).optional(),
  status_code: z.string().optional(),
});

const naabuLineSchema = z
  .object({
    ip: z.string().optional(),
    host: z.string().optional(),
    port: z.int().min(1).max(PORT_MAX),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
  })
  .refine((line) => line.ip !== undefined || line.host !== undefined);

const fingerprintxLineSchema = z.looseObject({
  ip: z.string().optional(),
  host: z.string().optional(),
  port: z.int().min(1).max(PORT_MAX),
  protocol: z.string(),
  version: z.string().optional(),
  metadata: z
    .looseObject({ product: z.string().optional(), version: z.string().optional() })
    .optional(),
});

function parseLines<T>(stdout: string, read: (json: unknown) => T | null): Parsed<T> {
  const records: T[] = [];
  let malformed = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let record: T | null = null;
    try {
      record = read(JSON.parse(line));
    } catch {
      // Not JSON: counted below.
    }
    if (record === null) malformed += 1;
    else records.push(record);
  }
  return { records, malformed };
}

/**
 * Parses `dnsx -json` output (one JSON object per line). Only NOERROR answers with at least one valid
 * address become records; addresses that are not IP literals are dropped.
 */
export function parseDnsx(stdout: string): Parsed<DnsxRecord> {
  return parseLines(stdout, (json) => {
    const line = dnsxLineSchema.safeParse(json);
    const host = line.success ? normaliseHost(line.data.host) : null;
    if (!line.success || host === null) return null;
    if (line.data.status_code !== undefined && line.data.status_code !== 'NOERROR') {
      return { host, ips: [] };
    }
    const ips = [...(line.data.a ?? []), ...(line.data.aaaa ?? [])]
      .map((ip) => normaliseIp(ip))
      .filter((ip) => ip !== null);
    return { host, ips: [...new Set(ips)] };
  });
}

/** Parses `naabu -json` output (one JSON object per line); `ip` falls back to `host` when it is an IP literal. */
export function parseNaabu(stdout: string): Parsed<NaabuResult> {
  return parseLines(stdout, (json) => {
    const line = naabuLineSchema.safeParse(json);
    if (!line.success) return null;
    const ip = normaliseIp(line.data.ip ?? line.data.host ?? '');
    return ip === null ? null : { ip, port: line.data.port, proto: line.data.protocol };
  });
}

/**
 * Parses `httpx -json` output (one JSON object per line). Rows httpx marks as failed, and rows without a URL,
 * are malformed. Only the fields the tools return are kept, each bounded in length.
 */
export function parseHttpx(stdout: string): Parsed<HttpxRecord> {
  return parseLines(stdout, (json) => {
    const line = httpxLineSchema.safeParse(json);
    if (!line.success || line.data.failed === true) return null;
    const tech = (line.data.tech ?? [])
      .slice(0, TECH_PER_ROW_MAX)
      .map((value) => value.slice(0, TECH_MAX));
    return {
      url: line.data.url.slice(0, URL_MAX),
      status: line.data.status_code ?? null,
      title: line.data.title === undefined ? null : line.data.title.slice(0, TEXT_MAX),
      webserver: line.data.webserver === undefined ? null : line.data.webserver.slice(0, TECH_MAX),
      tech,
    };
  });
}

/**
 * Parses `fingerprintx --json` output (one JSON object per line). A row needs an IP literal, a port and a
 * protocol name; a product or version that does not match a strict character set is dropped (the service is kept
 * as the protocol alone) because banner text is attacker-controlled. Versions are observations, never verdicts.
 */
export function parseFingerprintx(stdout: string): Parsed<FingerprintxResult> {
  return parseLines(stdout, (json) => {
    const line = fingerprintxLineSchema.safeParse(json);
    if (!line.success) return null;
    const ip = normaliseIp(line.data.ip ?? line.data.host ?? '');
    const protocol = line.data.protocol.toLowerCase();
    if (ip === null || !PROTOCOL.test(protocol)) return null;
    const product = line.data.metadata?.product ?? null;
    const version = line.data.metadata?.version ?? line.data.version ?? null;
    return {
      ip,
      port: line.data.port,
      protocol,
      product: product !== null && PRODUCT.test(product) ? product : null,
      version: version !== null && PRODUCT_VERSION.test(version) ? version : null,
    };
  });
}
