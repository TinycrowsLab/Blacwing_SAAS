import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  normaliseHost,
  normaliseIp,
  type ScopeRules,
  type ScopeTarget,
} from '@blackwing/contracts';
import { addressRules, matchScope, parseSurfaceUrl } from '@blackwing/domain';

import { ToolError } from '../errors.js';
import { defineTool, type ToolDefinition, type ToolHandlerContext } from '../tool.js';
import { HTTPX_DEFAULTS } from './httpx.js';
import { parseDnsx, parseHttpx, parseNaabu } from './parse.js';

import type { EvidenceSink } from '../truncate.js';
import type { ReconExecutor, ReconTool } from './exec.js';
import type { ReconRunMetrics } from './metrics.js';

/**
 * Typed wrappers around the pinned ProjectDiscovery binaries (MCP-010): `run_httpx`, `run_naabu`, `run_dnsx`.
 * Agents supply only targets. Flags come from a fixed, reviewed set per tool, every run is scope-checked before
 * the binary starts, and the output is parsed into bounded JSON. Raw stdout is kept as evidence.
 */

const TRACER = 'blackwing.mcp-tools';
const SERVER = 'target';
const TOOL_TIMEOUT_MS = 120_000;
const RESULTS_MAX = 500;
const URL_MAX = 2048;
const HOST_MAX = 255;
const SUMMARY_MAX = 512;
const PORT_MAX = 65_535;
const HTTPX_TARGETS_MAX = 100;
const NAABU_HOSTS_MAX = 64;
const NAABU_PORTS_MAX = 100;
const DNSX_NAMES_MAX = 100;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const IP_LITERAL = /^[0-9.]+$|:/;

/** Every flag any run may pass. Nothing else reaches a binary; `assertAllowedFlags` enforces it. */
export const RECON_FLAG_ALLOWLIST: Readonly<Record<ReconTool, ReadonlySet<string>>> = {
  httpx: new Set([
    '-json',
    '-silent',
    '-no-color',
    '-tech-detect',
    '-tls-grab',
    '-include-chain',
    '-follow-redirects',
    '-max-redirects',
    '-rate-limit',
    '-timeout',
    '-retries',
    '-response-size-to-read',
    '-proxy',
  ]),
  naabu: new Set([
    '-p',
    '-scan-type',
    '-Pn',
    '-json',
    '-silent',
    '-no-color',
    '-retries',
    '-rate',
    '-c',
  ]),
  dnsx: new Set(['-json', '-silent', '-a', '-aaaa', '-retry', '-rl', '-t']),
};

/**
 * Throws when an argument vector carries a flag outside the tool's allowlist. Values never start with `-`, so
 * every token that does is a flag. A violation is a programming error in this module, not a model input.
 */
export function assertAllowedFlags(tool: ReconTool, args: readonly string[]): void {
  for (const arg of args) {
    if (arg.startsWith('-') && !RECON_FLAG_ALLOWLIST[tool].has(arg)) {
      throw new TypeError(`${tool} flag is not allowlisted: ${arg}`);
    }
  }
}

/** Pinned versions of the three binaries, recorded for every run (§8.9). Fixed by the session, never by input. */
export interface ReconRunSession {
  readonly executor: ReconExecutor;
  readonly scope: ScopeRules;
  readonly toolVersions: Readonly<Record<ReconTool, string>>;
  /** Stores raw stdout of every run as evidence. */
  readonly evidence: EvidenceSink;
  readonly metrics: ReconRunMetrics;
  /** Egress gateway proxy URL (http or https); httpx is pointed at it with `-proxy`. */
  readonly proxyUrl: string;
  readonly rps: number;
  readonly concurrency: number;
}

const urlSchema = z
  .string()
  .min(1)
  .max(URL_MAX)
  .refine((raw) => {
    try {
      parseSurfaceUrl(raw);
      return true;
    } catch {
      return false;
    }
  }, 'must be an absolute http or https URL');

/** naabu takes IP literals only: a name would resolve to an address the scope check never saw. */
const ipSchema = z
  .string()
  .min(1)
  .max(HOST_MAX)
  .refine((raw) => ipOf(raw) !== null, 'must be an IP address');

const nameSchema = z
  .string()
  .min(1)
  .max(HOST_MAX)
  .refine((raw) => normaliseHost(raw) !== null, 'must be a host name');

const portSchema = z.int().min(1).max(PORT_MAX);

export const runHttpxInputSchema = z.strictObject({
  targets: z.array(urlSchema).min(1).max(HTTPX_TARGETS_MAX),
});
export const runNaabuInputSchema = z.strictObject({
  hosts: z.array(ipSchema).min(1).max(NAABU_HOSTS_MAX),
  ports: z.array(portSchema).min(1).max(NAABU_PORTS_MAX),
});
export const runDnsxInputSchema = z.strictObject({
  names: z.array(nameSchema).min(1).max(DNSX_NAMES_MAX),
});

const runMetaSchema = {
  toolVersion: z.string(),
  flags: z.array(z.string()),
  rawEvidence: z.string(),
  malformed: z.int().nonnegative(),
  total: z.int().nonnegative(),
  truncated: z.boolean(),
};

const httpxRecordSchema = z.strictObject({
  url: z.string(),
  status: z.int().nullable(),
  title: z.string().nullable(),
  webserver: z.string().nullable(),
  tech: z.array(z.string()),
});
export const runHttpxOutputSchema = z.strictObject({
  ...runMetaSchema,
  records: z.array(httpxRecordSchema),
});

const naabuRecordSchema = z.strictObject({
  host: z.string(),
  port: z.int(),
  proto: z.enum(['tcp', 'udp']),
  state: z.literal('open'),
});
export const runNaabuOutputSchema = z.strictObject({
  ...runMetaSchema,
  records: z.array(naabuRecordSchema),
  /** Results outside the requested hosts, ports or scope; counted, never returned. */
  dropped: z.int().nonnegative(),
});

const dnsxRecordSchema = z.strictObject({
  name: z.string(),
  records: z.array(z.string()),
});
export const runDnsxOutputSchema = z.strictObject({
  ...runMetaSchema,
  records: z.array(dnsxRecordSchema),
});

type RunHttpxOutput = z.infer<typeof runHttpxOutputSchema>;
type RunNaabuOutput = z.infer<typeof runNaabuOutputSchema>;
type RunDnsxOutput = z.infer<typeof runDnsxOutputSchema>;

const tracer = trace.getTracer(TRACER);

/** Canonical IP literal (brackets stripped), or null. */
const ipOf = (raw: string): string | null => normaliseIp(raw.replace(/^\[|\]$/g, ''));

/** Scope target for a host (optionally with a port). IP literals are matched as IPs, names as hosts. */
function hostTarget(address: string, port?: number): ScopeTarget {
  const base: ScopeTarget = ipOf(address) !== null ? { ip: address } : { host: address };
  return port === undefined ? base : { ...base, port };
}

function urlTarget(raw: string): ScopeTarget {
  const url = parseSurfaceUrl(raw);
  const base: ScopeTarget = IP_LITERAL.test(url.host) ? { ip: url.host } : { host: url.host };
  return { ...base, port: url.port, path: url.path, method: 'GET' };
}

const denied = (): ToolError =>
  new ToolError('TOOL_SCOPE_DENIED', 'a target is outside the scope envelope');
const killed = (): ToolError => new ToolError('TOOL_KILLED', 'the run was killed');

interface RunSpec {
  readonly tool: ReconTool;
  readonly flags: readonly string[];
  readonly stdin: string;
  readonly inputSummary: string;
}

interface RunOutcome {
  readonly stdout: string;
  readonly rawEvidence: string;
  readonly flags: readonly string[];
  readonly toolVersion: string;
}

/**
 * Runs one binary: checks the flags, runs it under a span, stores the raw stdout as evidence, posts one audit
 * event with the flag set used and the pinned version (win or fail), and records the run metrics.
 */
async function runBinary(
  session: ReconRunSession,
  context: ToolHandlerContext,
  spec: RunSpec,
): Promise<RunOutcome> {
  assertAllowedFlags(spec.tool, spec.flags);
  const { signal } = context;
  // A call, so TypeScript does not narrow the flag across the awaits below (the kill can land at any point).
  const killedNow = (): boolean => signal.aborted;
  if (killedNow()) throw killed();
  const toolVersion = session.toolVersions[spec.tool];
  const span = tracer.startSpan('mcp.recon', { attributes: { 'recon.tool': spec.tool } });
  const started = Date.now();
  let stdout = '';
  let failure: ToolError | undefined;
  let rawEvidence = '';
  try {
    stdout = await session.executor.run(spec.tool, spec.flags, {
      stdin: spec.stdin,
      signal,
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    if (killedNow()) throw killed();
    rawEvidence = await session.evidence
      .store({
        content: stdout,
        contentType: 'application/x-ndjson',
        description: `Raw ${spec.tool} output (${toolVersion})`,
      })
      .catch(() => {
        throw new ToolError(
          'TOOL_BACKEND_UNAVAILABLE',
          'raw output could not be stored as evidence',
        );
      });
  } catch (error) {
    failure = killedNow()
      ? killed()
      : error instanceof ToolError
        ? error
        : new ToolError('TOOL_BACKEND_UNAVAILABLE', `${spec.tool} failed`);
  } finally {
    const durationMs = Date.now() - started;
    span.setStatus(
      failure === undefined
        ? { code: SpanStatusCode.OK }
        : { code: SpanStatusCode.ERROR, message: failure.code },
    );
    span.end();
    session.metrics.runs.inc({ tool: spec.tool, result: failure?.code ?? 'success' });
    session.metrics.duration.observe({ tool: spec.tool }, durationMs);
    await context.broker.post('tool-audit', {
      toolName: `mcp__${SERVER}__run_${spec.tool}`,
      subtaskId: context.subtaskId,
      testCaseId: context.testCaseId,
      roleId: context.roleId,
      flags: [...spec.flags],
      toolVersion,
      durationMs,
      outputBytes: Buffer.byteLength(stdout, 'utf8'),
      outcome: failure === undefined ? 'success' : 'error',
      code: failure?.code ?? null,
      inputSummary: spec.inputSummary.slice(0, SUMMARY_MAX),
    });
  }
  if (failure !== undefined) throw failure;
  return { stdout, rawEvidence, flags: spec.flags, toolVersion };
}

/** The `run_httpx` argument vector. Targets go on stdin. Response headers are not requested: they carry cookies. */
function httpxFlags(session: ReconRunSession): string[] {
  const positive = (n: number): string => String(Math.max(1, Math.floor(n)));
  return [
    '-json',
    '-silent',
    '-no-color',
    '-tech-detect',
    '-tls-grab',
    '-include-chain',
    '-follow-redirects',
    '-max-redirects',
    positive(HTTPX_DEFAULTS.maxRedirects),
    '-rate-limit',
    positive(session.rps),
    '-timeout',
    positive(HTTPX_DEFAULTS.timeoutSeconds),
    '-retries',
    '0',
    '-response-size-to-read',
    positive(HTTPX_DEFAULTS.maxBodyBytes),
    '-proxy',
    session.proxyUrl,
  ];
}

/** Records above the cap are dropped from the inline result; the raw output stays in evidence. */
function bounded<T>(records: readonly T[]): { records: T[]; total: number; truncated: boolean } {
  return {
    records: records.slice(0, RESULTS_MAX),
    total: records.length,
    truncated: records.length > RESULTS_MAX,
  };
}

function assertVersions(versions: Readonly<Record<ReconTool, string>>): void {
  for (const tool of Object.keys(RECON_FLAG_ALLOWLIST) as ReconTool[]) {
    if (!VERSION.test(versions[tool])) {
      throw new TypeError(`${tool} needs a pinned version string`);
    }
  }
}

/** `mcp__target__run_httpx` (MCP-010): HTTP probing and technology fingerprinting of in-scope URLs. */
export function createRunHttpxTool(session: ReconRunSession): ToolDefinition {
  assertVersions(session.toolVersions);
  return defineTool({
    server: SERVER,
    name: 'run_httpx',
    description:
      'Probe in-scope http(s) URLs with httpx through the egress gateway. Returns status, title, server and technology per URL.',
    inputSchema: runHttpxInputSchema,
    outputSchema: runHttpxOutputSchema,
    readOnly: true,
    openWorld: true,
    handler: async (input, context): Promise<{ ok: true; data: RunHttpxOutput }> => {
      for (const target of input.targets) {
        if (!matchScope(urlTarget(target), session.scope).inScope) throw denied();
      }
      const run = await runBinary(session, context, {
        tool: 'httpx',
        flags: httpxFlags(session),
        stdin: `${input.targets.join('\n')}\n`,
        inputSummary: `httpx ${String(input.targets.length)} url(s)`,
      });
      const parsed = parseHttpx(run.stdout);
      const page = bounded(parsed.records);
      return {
        ok: true,
        data: {
          toolVersion: run.toolVersion,
          flags: [...run.flags],
          rawEvidence: run.rawEvidence,
          malformed: parsed.malformed,
          total: page.total,
          truncated: page.truncated,
          records: page.records.map((record) => ({
            url: record.url,
            status: record.status,
            title: record.title,
            webserver: record.webserver,
            tech: [...record.tech],
          })),
        },
      };
    },
  });
}

/**
 * `mcp__target__run_naabu` (MCP-010): TCP connect scan of in-scope ports only. Every host and port pair is
 * checked against the scope before the scanner starts; one out-of-scope pair denies the whole call.
 */
export function createRunNaabuTool(session: ReconRunSession): ToolDefinition {
  assertVersions(session.toolVersions);
  return defineTool({
    server: SERVER,
    name: 'run_naabu',
    description:
      'TCP connect scan of the given ports on in-scope hosts (active_safe, through the egress gateway). Returns open ports only.',
    inputSchema: runNaabuInputSchema,
    outputSchema: runNaabuOutputSchema,
    readOnly: false,
    openWorld: true,
    handler: async (input, context): Promise<{ ok: true; data: RunNaabuOutput }> => {
      const hosts = [...new Set(input.hosts.map((raw) => ipOf(raw)))].filter(
        (ip): ip is string => ip !== null,
      );
      const ports = [...new Set(input.ports)].sort((a, b) => a - b);
      for (const host of hosts) {
        for (const port of ports) {
          if (!matchScope(hostTarget(host, port), session.scope).inScope) throw denied();
        }
      }
      const run = await runBinary(session, context, {
        tool: 'naabu',
        flags: [
          '-p',
          ports.join(','),
          '-scan-type',
          'c',
          '-Pn',
          '-json',
          '-silent',
          '-no-color',
          '-retries',
          '1',
          '-rate',
          String(session.rps),
          '-c',
          String(session.concurrency),
        ],
        stdin: `${hosts.join('\n')}\n`,
        inputSummary: `naabu ${String(hosts.length)} host(s) ${String(ports.length)} port(s)`,
      });
      const parsed = parseNaabu(run.stdout);
      const probed = new Set(ports);
      const requested = new Set(hosts);
      const kept: { host: string; port: number; proto: 'tcp' | 'udp'; state: 'open' }[] = [];
      let dropped = 0;
      for (const found of parsed.records) {
        // A result must name a requested port, a host that was asked for, and stay inside the envelope.
        const inScope = matchScope(hostTarget(found.ip, found.port), session.scope).inScope;
        if (!probed.has(found.port) || !requested.has(found.ip) || !inScope) {
          dropped += 1;
          continue;
        }
        kept.push({ host: found.ip, port: found.port, proto: found.proto, state: 'open' });
      }
      const page = bounded(kept);
      return {
        ok: true,
        data: {
          toolVersion: run.toolVersion,
          flags: [...run.flags],
          rawEvidence: run.rawEvidence,
          malformed: parsed.malformed,
          total: page.total,
          truncated: page.truncated,
          dropped,
          records: page.records,
        },
      };
    },
  });
}

/** `mcp__target__run_dnsx` (MCP-010): A/AAAA resolution of in-scope names. Read-only. */
export function createRunDnsxTool(session: ReconRunSession): ToolDefinition {
  assertVersions(session.toolVersions);
  const envelope = addressRules(session.scope);
  return defineTool({
    server: SERVER,
    name: 'run_dnsx',
    description:
      'Resolve in-scope host names to A and AAAA records (read-only, through the gateway).',
    inputSchema: runDnsxInputSchema,
    outputSchema: runDnsxOutputSchema,
    readOnly: true,
    openWorld: true,
    handler: async (input, context): Promise<{ ok: true; data: RunDnsxOutput }> => {
      const names = [...new Set(input.names.map((raw) => normaliseHost(raw) ?? raw))];
      for (const name of names) {
        if (!matchScope(hostTarget(name), envelope).inScope) throw denied();
      }
      const run = await runBinary(session, context, {
        tool: 'dnsx',
        flags: [
          '-json',
          '-silent',
          '-a',
          '-aaaa',
          '-retry',
          '1',
          '-rl',
          String(session.rps),
          '-t',
          String(session.concurrency),
        ],
        stdin: `${names.join('\n')}\n`,
        inputSummary: `dnsx ${String(names.length)} name(s)`,
      });
      const parsed = parseDnsx(run.stdout);
      const asked = new Set(names);
      const page = bounded(
        parsed.records
          .filter((record) => asked.has(record.host))
          .map((record) => ({ name: record.host, records: [...record.ips] })),
      );
      return {
        ok: true,
        data: {
          toolVersion: run.toolVersion,
          flags: [...run.flags],
          rawEvidence: run.rawEvidence,
          malformed: parsed.malformed,
          total: page.total,
          truncated: page.truncated,
          records: page.records,
        },
      };
    },
  });
}
