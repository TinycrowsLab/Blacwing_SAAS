import { spawn } from 'node:child_process';

import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Counter, Registry } from 'prom-client';
import { z } from 'zod';

import {
  endpointKey,
  hostKey,
  matchScope,
  parseSurfaceUrl,
  serviceKey,
  SURFACE_MAX_NODES,
  type SurfaceEdge,
  type SurfaceNode,
  type SurfaceWriteContext,
  technologyKey,
  writeSurface,
} from '@blackwing/domain';

import { ToolError } from '../errors.js';

/** ProjectDiscovery httpx (MIT) wrapper for active-recon (RECON-005): probe, fingerprint, write surface. */

const TRACER = 'blackwing.mcp-tools';
const MS_PER_SECOND = 1000;
const PROBE_TARGETS_MAX = 1000;
const KIB = 1024;
const STATUS_TOO_MANY_REQUESTS = 429;
/** Nodes one probed row writes: host, service, endpoint and at most one technology per row. */
const NODES_PER_ROW = 4;
/** Rows per surface write keep a batch under SURFACE_MAX_NODES. */
const ROWS_PER_WRITE = Math.floor(SURFACE_MAX_NODES / NODES_PER_ROW);
const STDOUT_MAX_MIB = 32;
const STDOUT_MAX_BYTES = KIB * KIB * STDOUT_MAX_MIB;
const HEADER_VALUE_MAX = 512;
const NAME_MAX = 128;
const VERSION_MAX = 64;
const TITLE_MAX = 256;
const RETRY_AFTER_MAX_MS = 30_000;

export const HTTPX_DEFAULTS = Object.freeze({
  maxRedirects: 5,
  /** Response bytes httpx reads per target (`-rstr`). */
  maxBodyBytes: 1_048_576,
  ratePerSecond: 20,
  timeoutSeconds: 10,
  /** Re-runs of targets that answered 429. */
  maxRetries: 2,
  backoffMs: 1000,
  budgetMs: 120_000,
});

/** Header names never recorded: they carry credentials or session identifiers (§8.6). */
const SECRET_HEADER = /^(set-)?cookie$|auth|token|secret|session|api[-_]?key|password|credential/i;

export interface HttpxMetrics {
  readonly registry: Registry;
  /** `recon_http_endpoints_total`: live HTTP endpoints recorded. */
  readonly endpoints: Counter;
  /** `recon_tech_total`: technology nodes recorded. */
  readonly technologies: Counter;
}

export function createHttpxMetrics(registry: Registry = new Registry()): HttpxMetrics {
  return {
    registry,
    endpoints: new Counter({
      name: 'recon_http_endpoints_total',
      help: 'Live HTTP endpoints recorded by httpx probing.',
      registers: [registry],
    }),
    technologies: new Counter({
      name: 'recon_tech_total',
      help: 'Technology nodes recorded by httpx fingerprinting.',
      registers: [registry],
    }),
  };
}

const chainEntrySchema = z.looseObject({
  'request-url': z.string().optional(),
  location: z.string().optional(),
  status_code: z.number().optional(),
});

const rowSchema = z.looseObject({
  url: z.string(),
  input: z.string().optional(),
  final_url: z.string().optional(),
  status_code: z.number().optional(),
  title: z.string().optional(),
  webserver: z.string().optional(),
  content_type: z.string().optional(),
  content_length: z.number().optional(),
  tech: z.array(z.string()).optional(),
  chain: z.array(chainEntrySchema).optional(),
  header: z.record(z.string(), z.unknown()).optional(),
  tls: z.record(z.string(), z.unknown()).optional(),
  failed: z.boolean().optional(),
});
type HttpxRow = z.infer<typeof rowSchema>;

export interface HttpxOptions {
  readonly maxRedirects: number;
  readonly maxBodyBytes: number;
  readonly ratePerSecond: number;
  readonly timeoutSeconds: number;
  /** Egress gateway proxy URL; every probe goes through it (§4.1). */
  readonly proxyUrl: string;
}

/**
 * The httpx argument vector. Targets go on stdin, never in argv. No scope flag is passed on purpose:
 * the egress gateway owns scope and redirect blocking (§8.2), httpx is not trusted to enforce it.
 */
export function buildHttpxArgs(options: HttpxOptions): string[] {
  const proxy = new URL(options.proxyUrl);
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new ToolError('TOOL_INVALID_INPUT', 'httpx proxy must be http or https');
  }
  const positive = (n: number): string => String(Math.max(1, Math.floor(n)));
  return [
    '-json',
    '-silent',
    '-no-color',
    '-tech-detect',
    '-tls-grab',
    '-include-response-header',
    '-include-chain',
    '-follow-redirects',
    '-max-redirects',
    positive(options.maxRedirects),
    '-rate-limit',
    positive(options.ratePerSecond),
    '-timeout',
    positive(options.timeoutSeconds),
    '-retries',
    '0',
    '-response-size-to-read',
    positive(options.maxBodyBytes),
    '-proxy',
    proxy.toString(),
  ];
}

export interface TechSignal {
  readonly product: string;
  readonly version?: string;
}

/** `Nginx:1.18.0` (Wappalyzer style) or `nginx/1.18.0 (Ubuntu)` (Server header) to product and version. */
export function parseTech(raw: string): TechSignal | null {
  const text = raw.trim();
  const match =
    /^(.+?):([0-9][\w.+-]*)$/.exec(text) ?? /^([A-Za-z][\w.-]*)\/([0-9][\w.+-]*)/.exec(text);
  const product = (match?.[1] ?? text.split(/[\s/]/)[0] ?? '').trim();
  const version = match?.[2];
  if (product === '' || product.length > NAME_MAX) return null;
  return version !== undefined && version.length <= VERSION_MAX
    ? { product, version }
    : { product };
}

function technologies(row: HttpxRow): TechSignal[] {
  const byProduct = new Map<string, TechSignal>();
  for (const raw of [
    ...(row.tech ?? []),
    ...(row.webserver === undefined ? [] : [row.webserver]),
  ]) {
    const tech = parseTech(raw);
    if (tech === null) continue;
    const id = tech.product.toLowerCase();
    // A signal that discloses a version wins over one that does not.
    if (byProduct.get(id)?.version === undefined) byProduct.set(id, tech);
  }
  return [...byProduct.values()];
}

function safeHeaders(header: HttpxRow['header']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(header ?? {})) {
    if (SECRET_HEADER.test(name)) continue;
    const text = Array.isArray(value) ? value.join(', ') : value;
    if (typeof text === 'string') out[name.toLowerCase()] = text.slice(0, HEADER_VALUE_MAX);
  }
  return out;
}

const TLS_FIELDS = [
  'version',
  'cipher',
  'subject_cn',
  'issuer_cn',
  'not_before',
  'not_after',
  'self_signed',
  'expired',
  'mismatched',
] as const;

/** Certificate metadata only (never key material). A TLS error is metadata, not a finding. */
function safeTls(tls: HttpxRow['tls']): Record<string, string | boolean> | null {
  if (tls === undefined) return null;
  const out: Record<string, string | boolean> = {};
  for (const field of TLS_FIELDS) {
    const value = tls[field];
    if (typeof value === 'string' || typeof value === 'boolean') out[field] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

export interface RedirectRecord {
  /** Every URL on the redirect path, in order, starting with the probed one. */
  readonly chain: readonly string[];
  /** First hop outside the envelope scope: it is recorded, never followed or written. */
  readonly blockedAt: string | null;
  /** The chain repeated a URL or ran past the redirect cap. */
  readonly loop: boolean;
}

export interface HttpEndpointRecord {
  readonly key: string;
  readonly url: string;
  readonly status: number | null;
  readonly title: string | null;
  readonly server: string | null;
  readonly contentType: string | null;
  readonly contentLength: number | null;
  /** The body exceeded the read cap, so only the first `maxBodyBytes` were inspected. */
  readonly bodyTruncated: boolean;
  readonly headers: Record<string, string>;
  readonly tls: Record<string, string | boolean> | null;
  readonly redirects: RedirectRecord;
  readonly technologies: readonly TechSignal[];
}

export interface SkippedTarget {
  readonly url: string;
  readonly reason: 'out_of_scope' | 'invalid_url' | 'probe_failed';
}

export interface HttpProbeContext {
  /** Tenant, scope and `mcp__blackwing__write_surface` caller; the tool call is injected. */
  readonly write: SurfaceWriteContext;
  readonly assetId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly toolVersion: string;
  /** Runs httpx with `args`, feeding `stdin`, and returns its stdout. */
  readonly run: (args: readonly string[], stdin: string, signal: AbortSignal) => Promise<string>;
  readonly signal: AbortSignal;
  readonly options: Pick<HttpxOptions, 'proxyUrl'> & Partial<HttpxOptions>;
  readonly metrics?: HttpxMetrics;
  /** Per-test-case wall-clock budget in ms; probing and 429 backoff stay inside it. */
  readonly budgetMs?: number;
  readonly maxRetries?: number;
  readonly backoffMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface HttpProbeResult {
  readonly endpoints: readonly HttpEndpointRecord[];
  readonly skipped: readonly SkippedTarget[];
  readonly nodeCount: number;
}

function inScope(write: SurfaceWriteContext, raw: string): boolean {
  try {
    const url = parseSurfaceUrl(raw);
    const target = /^[0-9.]+$|:/.test(url.host) ? { ip: url.host } : { host: url.host };
    return matchScope({ ...target, port: url.port, path: url.path, method: 'GET' }, write.scope)
      .inScope;
  } catch {
    return false;
  }
}

function redirectsOf(
  row: HttpxRow,
  input: string,
  ctx: HttpProbeContext,
  max: number,
): RedirectRecord {
  const hops = row.chain ?? [];
  const chain = [input];
  for (const hop of hops) {
    const url = hop['request-url'];
    if (url !== undefined) chain.push(url);
  }
  const last = row.final_url ?? row.url;
  chain.push(last);
  for (const hop of hops) {
    if (hop.location === undefined) continue;
    try {
      chain.push(new URL(hop.location, hop['request-url'] ?? input).toString());
    } catch {
      chain.push(hop.location);
    }
  }
  const ordered = [...new Set(chain)];
  const blockedAt = ordered.find((url) => !inScope(ctx.write, url)) ?? null;
  const requested = hops.flatMap((hop) => hop['request-url'] ?? []);
  const loop = hops.length > max || new Set(requested).size < requested.length;
  return { chain: ordered, blockedAt, loop };
}

interface Prepared {
  readonly record: HttpEndpointRecord;
  readonly nodes: SurfaceNode[];
  readonly edges: SurfaceEdge[];
}

function prepare(row: HttpxRow, ctx: HttpProbeContext, max: number, maxBody: number): Prepared {
  const input = row.input ?? row.url;
  const root = parseSurfaceUrl(input);
  const origin = `${root.scheme}://${root.host.includes(':') ? `[${root.host}]` : root.host}:${root.port}/`;
  const redirects = redirectsOf(row, input, ctx, max);
  // A blocked redirect leaves the redirect response itself as what the endpoint answered.
  const status =
    redirects.blockedAt === null
      ? (row.status_code ?? null)
      : (row.chain?.[0]?.status_code ?? row.status_code ?? null);
  const host = hostKey(ctx.assetId, root.host);
  const service = serviceKey(host, root.port, 'tcp');
  const endpoint = endpointKey(ctx.assetId, 'GET', origin);
  const techs = technologies(row);
  const nodes: SurfaceNode[] = [
    { type: 'host', assetId: ctx.assetId, address: root.host },
    {
      type: 'service',
      assetId: ctx.assetId,
      address: root.host,
      port: root.port,
      proto: 'tcp',
      name: root.scheme,
    },
    { type: 'endpoint', assetId: ctx.assetId, method: 'GET', url: origin },
    ...techs.map((tech): SurfaceNode => ({
      type: 'technology',
      assetId: ctx.assetId,
      address: root.host,
      product: tech.product,
      ...(tech.version === undefined ? {} : { version: tech.version }),
    })),
  ];
  const edges: SurfaceEdge[] = [
    { type: 'exposes', from: host, to: service },
    { type: 'serves', from: service, to: endpoint },
    ...techs.map((tech): SurfaceEdge => ({
      type: 'runs',
      from: host,
      to: technologyKey(host, tech.product, tech.version),
    })),
  ];
  const record: HttpEndpointRecord = {
    key: endpoint,
    url: origin,
    status,
    title: row.title === undefined ? null : row.title.slice(0, TITLE_MAX),
    server: row.webserver?.slice(0, NAME_MAX) ?? null,
    contentType: row.content_type?.slice(0, NAME_MAX) ?? null,
    contentLength: row.content_length ?? null,
    bodyTruncated: (row.content_length ?? 0) > maxBody,
    headers: safeHeaders(row.header),
    tls: safeTls(row.tls),
    redirects,
    technologies: techs,
  };
  return { record, nodes, edges };
}

function parseRows(stdout: string): HttpxRow[] {
  const rows: HttpxRow[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = rowSchema.safeParse(JSON.parse(line));
      if (parsed.success) rows.push(parsed.data);
    } catch {
      // httpx may print a banner or a partial line; only well-formed JSON rows count.
    }
  }
  return rows;
}

function retryAfterMs(row: HttpxRow | undefined, fallback: number): number {
  const header = Object.entries(row?.header ?? {}).find(([n]) => n.toLowerCase() === 'retry-after');
  const seconds = typeof header?.[1] === 'string' ? Number(header[1]) : Number.NaN;
  const ms = Number.isFinite(seconds) && seconds >= 0 ? seconds * MS_PER_SECOND : fallback;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

/**
 * Probes in-scope URLs with httpx and writes `service`, `endpoint` and `technology` nodes (RECON-005).
 * Out-of-scope targets are never sent; redirect hops are re-checked against the scope, recorded, and a
 * hop outside it is not written; 429s back off inside the budget; TLS errors stay metadata.
 * @throws {ToolError} TOOL_INVALID_INPUT, TOOL_BUDGET_EXCEEDED, TOOL_KILLED.
 */
export function probeHttp(
  ctx: HttpProbeContext,
  targets: readonly string[],
): Promise<HttpProbeResult> {
  return trace.getTracer(TRACER).startActiveSpan('tool.httpx', async (span) => {
    try {
      return await probe(ctx, targets);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function probe(ctx: HttpProbeContext, targets: readonly string[]): Promise<HttpProbeResult> {
  if (targets.length === 0 || targets.length > PROBE_TARGETS_MAX) {
    throw new ToolError('TOOL_INVALID_INPUT', `give between 1 and ${PROBE_TARGETS_MAX} targets`);
  }
  const options: HttpxOptions = { ...HTTPX_DEFAULTS, ...ctx.options };
  const budgetMs = ctx.budgetMs ?? HTTPX_DEFAULTS.budgetMs;
  const now = ctx.now ?? Date.now;
  const sleep =
    ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + budgetMs;
  const args = buildHttpxArgs(options);
  const skipped: SkippedTarget[] = [];
  const accepted: string[] = [];
  for (const target of new Set(targets)) {
    let url: string;
    try {
      url = parseSurfaceUrl(target).template;
    } catch {
      skipped.push({ url: target, reason: 'invalid_url' });
      continue;
    }
    if (inScope(ctx.write, target)) accepted.push(target);
    else skipped.push({ url, reason: 'out_of_scope' });
  }

  let pending = accepted;
  const rows = new Map<string, HttpxRow>();
  const maxRetries = ctx.maxRetries ?? HTTPX_DEFAULTS.maxRetries;
  for (let attempt = 0; pending.length > 0; attempt += 1) {
    if (ctx.signal.aborted) throw new ToolError('TOOL_KILLED', 'the run was killed');
    if (now() >= deadline) {
      if (attempt === 0) throw new ToolError('TOOL_BUDGET_EXCEEDED', 'no probe budget left');
      break;
    }
    const stdout = await ctx.run(args, `${pending.join('\n')}\n`, ctx.signal);
    for (const row of parseRows(stdout)) rows.set(row.input ?? row.url, row);
    const limited = pending.filter(
      (url) => rows.get(url)?.status_code === STATUS_TOO_MANY_REQUESTS,
    );
    if (attempt >= maxRetries || limited.length === 0) break;
    const fallback = (ctx.backoffMs ?? HTTPX_DEFAULTS.backoffMs) * 2 ** attempt;
    const wait = Math.max(...limited.map((url) => retryAfterMs(rows.get(url), fallback)));
    if (now() + wait >= deadline) break;
    await sleep(wait);
    pending = limited;
  }

  const prepared: Prepared[] = [];
  for (const target of accepted) {
    const row = rows.get(target);
    if (row === undefined || row.failed === true) {
      skipped.push({ url: target, reason: 'probe_failed' });
      continue;
    }
    prepared.push(prepare(row, ctx, options.maxRedirects, options.maxBodyBytes));
  }

  let nodeCount = 0;
  for (let i = 0; i < prepared.length; i += ROWS_PER_WRITE) {
    const batch = prepared.slice(i, i + ROWS_PER_WRITE);
    const result = await writeSurface(ctx.write, {
      nodes: batch.flatMap((p) => p.nodes),
      edges: batch.flatMap((p) => p.edges),
      provenance: {
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        persona: 'active-recon',
        tool: 'httpx',
        toolVersion: ctx.toolVersion,
        confidence: 0.9,
        observedAt: new Date(now()).toISOString(),
      },
    });
    nodeCount += result.nodeCount;
  }
  const endpoints = prepared.map((p) => p.record);
  ctx.metrics?.endpoints.inc(endpoints.length);
  ctx.metrics?.technologies.inc(endpoints.reduce((n, e) => n + e.technologies.length, 0));
  return { endpoints, skipped, nodeCount };
}

/** Runs the real `httpx` binary (inside the sandbox); stdout is capped and a kill terminates the process. */
export function spawnHttpx(binary = 'httpx'): HttpProbeContext['run'] {
  return (args, stdin, signal) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'ignore'], signal });
      const chunks: Buffer[] = [];
      let size = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > STDOUT_MAX_BYTES) child.kill('SIGKILL');
        else chunks.push(chunk);
      });
      child.on('error', () => {
        reject(
          signal.aborted
            ? new ToolError('TOOL_KILLED', 'the run was killed')
            : new ToolError('TOOL_BACKEND_UNAVAILABLE', 'httpx could not run'),
        );
      });
      child.on('close', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdin);
    });
}
