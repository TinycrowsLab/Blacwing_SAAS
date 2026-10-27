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

export interface Parsed<T> {
  readonly records: readonly T[];
  /** Lines that were not valid JSON or did not match the expected shape; never echoed (tool output is untrusted). */
  readonly malformed: number;
}

const PORT_MAX = 65_535;

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
