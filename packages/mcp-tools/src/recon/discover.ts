import { SpanStatusCode, trace } from '@opentelemetry/api';
import { z } from 'zod';

import {
  normaliseHost,
  normaliseIp,
  type ScopeRules,
  type ScopeTarget,
} from '@blackwing/contracts';
import {
  addressRules,
  hostKey,
  matchScope,
  SURFACE_MAX_NODES,
  type SurfaceEdge,
  type SurfaceNode,
  surfaceNodeKey,
  type SurfaceProvenance,
  type SurfaceWriteRequest,
} from '@blackwing/domain';

import { isNonPublicIp } from './addresses.js';
import { parseDnsx, parseNaabu } from './parse.js';
import { ToolError, type ToolErrorCode } from '../errors.js';

import type { ExecTool, ReconExecutor, ScanTool } from './exec.js';
import type { ReconMetrics } from './metrics.js';

const PORT_MAX = 65_535;
const HOSTS_INPUT_MAX = 256;
const PORTS_INPUT_MAX = 1024;
/** Listed out-of-scope sightings per call; the total is still counted. */
const OUT_OF_SCOPE_LISTED_MAX = 50;
const TOOL_TIMEOUT_MS = 120_000;
const SUMMARY_MAX = 512;
/** Confidence of a service seen open by a CONNECT scan, and of a name answered by the resolver. */
const SERVICE_CONFIDENCE = 0.9;
const HOST_CONFIDENCE = 0.95;

const ADDRESS_MAX = 255;
const COMMON_PORT_LIST =
  '21 22 23 25 53 80 110 143 443 445 465 587 993 995 1433 1521 2375 3000 3306 3389 ' +
  '5000 5432 5672 5900 6379 8000 8080 8081 8443 8888 9000 9200 9443 11211 27017';

/** Ports probed when the caller names none. Each is still filtered through the scope matcher per host. */
export const COMMON_PORTS: readonly number[] = COMMON_PORT_LIST.split(' ').map((port) =>
  Number(port),
);

const addressSchema = z
  .string()
  .min(1)
  .max(ADDRESS_MAX)
  .refine((raw) => canonical(raw) !== null, 'must be a host name or IP address');

/** What the model supplies. Scope, budget, asset and identity come from the session, never from here. */
export const discoverServicesInputSchema = z.strictObject({
  hosts: z.array(addressSchema).min(1).max(HOSTS_INPUT_MAX),
  ports: z.array(z.int().min(1).max(PORT_MAX)).min(1).max(PORTS_INPUT_MAX).optional(),
});
export type DiscoverServicesInput = z.infer<typeof discoverServicesInputSchema>;

const hostStatusSchema = z.enum(['scanned', 'unresolved', 'blocked', 'out_of_scope', 'skipped']);
const serviceSchema = z.strictObject({
  address: z.string(),
  port: z.int(),
  proto: z.enum(['tcp', 'udp']),
});
export const discoverServicesOutputSchema = z.strictObject({
  hosts: z.array(
    z.strictObject({
      address: z.string(),
      status: hostStatusSchema,
      pinnedIp: z.string().optional(),
    }),
  ),
  services: z.array(serviceSchema),
  /** Sightings outside the envelope or outside the probed set: tagged, never persisted (RECON-007 req. 5). */
  outOfScope: z.array(
    z.strictObject({ address: z.string(), port: z.int().optional(), reason: z.string() }),
  ),
  outOfScopeCount: z.int().nonnegative(),
  coverage: z.strictObject({
    hostsRequested: z.int().nonnegative(),
    hostsResolved: z.int().nonnegative(),
    hostsScanned: z.int().nonnegative(),
    portsScanned: z.int().nonnegative(),
    portsSkippedOutOfScope: z.int().nonnegative(),
    requestsUsed: z.int().nonnegative(),
    /** The host list was cut at the per-call host cap (also the wildcard-DNS guard). */
    truncated: z.boolean(),
    /** Why the scan stopped early; `null` when it ran to the end. Hosts not reached are `skipped`. */
    halted: z.enum(['budget', 'budget_signal']).nullable(),
  }),
});
export type DiscoverResult = z.infer<typeof discoverServicesOutputSchema>;

/** The per-test-case budget (EGRESS-004 enforces the same numbers at the gateway). */
export interface ReconBudget {
  /** Total requests: one per name resolved plus one per port probed. */
  readonly maxRequests: number;
  readonly rps: number;
  readonly concurrency: number;
  /** Hosts handled per call; more are dropped and `coverage.truncated` is set. */
  readonly maxHosts: number;
}

/** One executed batch of probes, for the audit trail (§8.8). */
export interface ProbeAuditEvent {
  readonly tool: ExecTool;
  readonly inputSummary: string;
  readonly durationMs: number;
  readonly outputBytes: number;
  readonly outcome: 'success' | 'error';
  readonly code: ToolErrorCode | null;
}

export interface DiscoverDeps {
  readonly executor: ReconExecutor;
  readonly scope: ScopeRules;
  readonly assetId: string;
  readonly budget: ReconBudget;
  readonly signal: AbortSignal;
  /** Pinned tool versions of the run (§8.9). */
  readonly toolVersions: Record<ScanTool, string>;
  readonly provenance: Pick<SurfaceProvenance, 'runId' | 'sessionId' | 'persona'>;
  /** Validates, scope-checks and stores a batch (the domain `writeSurface` bound to the run). */
  readonly writeSurface: (request: SurfaceWriteRequest) => Promise<unknown>;
  /** Records a probe batch. A failure aborts the scan: no audit, no further probes. */
  readonly audit: (event: ProbeAuditEvent) => Promise<void>;
  readonly metrics: ReconMetrics;
  /** The gateway's scoped resolver, when the sandbox does not already point at it. */
  readonly resolver?: string;
  readonly now?: () => string;
}

function canonical(raw: string): string | null {
  return normaliseIp(raw.replace(/^\[|\]$/g, '')) ?? normaliseHost(raw);
}

const isIp = (address: string): boolean => normaliseIp(address) !== null;

function target(address: string, port?: number): ScopeTarget {
  const base: ScopeTarget = isIp(address) ? { ip: address } : { host: address };
  return port === undefined ? base : { ...base, port };
}

/** An answer is scannable when no exclude rule names it and it is public or explicitly included by CIDR. */
function answerAllowed(ip: string, scope: ScopeRules): boolean {
  const decision = matchScope({ ip }, scope);
  if (decision.matchedRule?.effect === 'exclude') return false;
  return !isNonPublicIp(ip) || decision.inScope;
}

const tracer = trace.getTracer('blackwing.mcp-tools');

const killed = (): ToolError => new ToolError('TOOL_KILLED', 'the run was killed');

/**
 * Discovers listening services on in-scope hosts (RECON-007). Names are resolved once and pinned to the
 * first allowed answer; only that IP is probed, only on ports the matcher allows for the host, within the
 * request budget. Findings are written through `deps.writeSurface`; out-of-scope sightings are tagged only.
 * @throws {ToolError} `TOOL_KILLED`, `TOOL_BACKEND_UNAVAILABLE` (tool or audit failure), or what the surface
 * write raised; a budget stop is a normal result with `coverage.halted`.
 */
export async function discoverServices(
  deps: DiscoverDeps,
  input: DiscoverServicesInput,
): Promise<DiscoverResult> {
  const { budget, scope, assetId, signal } = deps;
  // A call, so TypeScript does not narrow the flag across the awaits below (the kill can land at any point).
  const killedNow = (): boolean => signal.aborted;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const requested = [
    ...new Set(
      input.hosts.map((raw) => canonical(raw)).filter((host): host is string => host !== null),
    ),
  ];
  const candidatePorts = [...new Set(input.ports ?? COMMON_PORTS)].sort((a, b) => a - b);
  const handled = requested.slice(0, budget.maxHosts);

  const hosts = new Map<string, DiscoverResult['hosts'][number]>();
  const services: DiscoverResult['services'] = [];
  const outOfScope: DiscoverResult['outOfScope'] = [];
  let outOfScopeCount = 0;
  const coverage = {
    hostsRequested: requested.length,
    hostsResolved: 0,
    hostsScanned: 0,
    portsScanned: 0,
    portsSkippedOutOfScope: 0,
    requestsUsed: 0,
    truncated: requested.length > handled.length,
    halted: null as 'budget' | 'budget_signal' | null,
  };
  const tagOutOfScope = (address: string, reason: string, port?: number): void => {
    outOfScopeCount += 1;
    if (outOfScope.length < OUT_OF_SCOPE_LISTED_MAX) {
      outOfScope.push({ address, reason, ...(port === undefined ? {} : { port }) });
    }
  };
  const finish = (): DiscoverResult => ({
    hosts: [...hosts.values()],
    services,
    outOfScope,
    outOfScopeCount,
    coverage,
  });

  const provenance = (tool: ScanTool, confidence: number): SurfaceProvenance => ({
    ...deps.provenance,
    tool,
    toolVersion: deps.toolVersions[tool],
    sourceKind: 'active',
    confidence,
    observedAt: now(),
  });
  const write = async (
    nodes: SurfaceNode[],
    edges: SurfaceEdge[],
    meta: SurfaceProvenance,
  ): Promise<void> => {
    for (let at = 0; at < Math.max(nodes.length, edges.length); at += SURFACE_MAX_NODES) {
      await deps.writeSurface({
        nodes: nodes.slice(at, at + SURFACE_MAX_NODES),
        edges: edges.slice(at, at + SURFACE_MAX_NODES),
        provenance: meta,
      });
    }
  };

  /** Runs one binary under a span and audits the batch whether it worked or not. */
  const probe = async (
    tool: ScanTool,
    args: readonly string[],
    stdin: string | undefined,
    inputSummary: string,
  ): Promise<string> => {
    if (signal.aborted) throw killed();
    const span = tracer.startSpan(`tool.${tool}`, { attributes: { 'recon.tool': tool } });
    const started = Date.now();
    let stdout = '';
    let failure: ToolError | undefined;
    try {
      stdout = await deps.executor.run(tool, args, {
        signal,
        timeoutMs: TOOL_TIMEOUT_MS,
        ...(stdin === undefined ? {} : { stdin }),
      });
      // A kill that lands as the tool finishes wins: nothing is reported or written after it.
      if (killedNow()) throw killed();
    } catch (error) {
      failure = killedNow()
        ? killed()
        : error instanceof ToolError
          ? error
          : new ToolError('TOOL_BACKEND_UNAVAILABLE', `${tool} failed`);
      span.setStatus({ code: SpanStatusCode.ERROR, message: failure.code });
    } finally {
      span.end();
    }
    await deps.audit({
      tool,
      inputSummary: inputSummary.slice(0, SUMMARY_MAX),
      durationMs: Date.now() - started,
      outputBytes: Buffer.byteLength(stdout, 'utf8'),
      outcome: failure === undefined ? 'success' : 'error',
      code: failure?.code ?? null,
    });
    if (failure !== undefined) throw failure;
    return stdout;
  };

  /** A budget signal ends the scan cleanly; any other failure propagates. */
  const budgetStop = (error: unknown): boolean => {
    if (error instanceof ToolError && error.code === 'TOOL_BUDGET_EXCEEDED') {
      coverage.halted = 'budget_signal';
      return true;
    }
    return false;
  };

  // 1. Scope gate: an out-of-scope name is never resolved, an out-of-scope IP never probed.
  const inScope: string[] = [];
  for (const address of handled) {
    if (matchScope(target(address), addressRules(scope)).inScope) inScope.push(address);
    else {
      hosts.set(address, { address, status: 'out_of_scope' });
      tagOutOfScope(address, 'host is outside the scope envelope');
    }
  }
  for (const address of inScope) hosts.set(address, { address, status: 'skipped' });

  // 2. Resolve each name once, through the gateway's resolver, and pin the first allowed answer.
  const pinned = new Map<string, string>();
  const names = inScope.filter((address) => !isIp(address));
  for (const address of inScope)
    if (isIp(address) && answerAllowed(address, scope)) pinned.set(address, address);
  const lookups = names.slice(0, Math.max(0, budget.maxRequests - coverage.requestsUsed));
  if (lookups.length < names.length) coverage.halted = 'budget';
  if (lookups.length > 0) {
    try {
      const stdout = await probe(
        'dnsx',
        [
          '-json',
          '-silent',
          '-a',
          '-aaaa',
          '-retry',
          '1',
          '-t',
          String(budget.concurrency),
          '-rl',
          String(budget.rps),
          ...(deps.resolver === undefined ? [] : ['-r', deps.resolver]),
        ],
        lookups.join('\n'),
        `dnsx resolve ${String(lookups.length)} host(s)`,
      );
      coverage.requestsUsed += lookups.length;
      const answers = new Map(parseDnsx(stdout).records.map((record) => [record.host, record.ips]));
      for (const name of lookups) {
        const ips = answers.get(name) ?? [];
        const allowed = ips.find((ip) => answerAllowed(ip, scope));
        if (allowed !== undefined) {
          pinned.set(name, allowed);
          hosts.set(name, { address: name, status: 'skipped', pinnedIp: allowed });
        } else {
          hosts.set(name, { address: name, status: ips.length === 0 ? 'unresolved' : 'blocked' });
          if (ips.length > 0)
            tagOutOfScope(name, 'every DNS answer is outside the allowed address space');
        }
      }
    } catch (error) {
      if (!budgetStop(error)) throw error;
    }
  }
  coverage.hostsResolved = pinned.size;

  // 3. Record resolved names (zero-service hosts included).
  const hostNodes: SurfaceNode[] = [];
  for (const name of names) {
    const pinnedIp = pinned.get(name);
    if (pinnedIp !== undefined) hostNodes.push({ type: 'host', assetId, address: name, pinnedIp });
  }
  await write(hostNodes, [], provenance('dnsx', HOST_CONFIDENCE));

  // 4. Probe the pinned IP of each host on the ports the matcher allows for it.
  for (const address of inScope) {
    const pinnedIp = pinned.get(address);
    if (pinnedIp === undefined || coverage.halted !== null) continue;
    const allowed = candidatePorts.filter(
      (port) => matchScope(target(address, port), scope).inScope,
    );
    coverage.portsSkippedOutOfScope += candidatePorts.length - allowed.length;
    const ports = allowed.slice(0, Math.max(0, budget.maxRequests - coverage.requestsUsed));
    if (ports.length < allowed.length) coverage.halted = 'budget';
    if (ports.length === 0) continue;
    let stdout: string;
    try {
      stdout = await probe(
        'naabu',
        [
          '-host',
          pinnedIp,
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
          String(budget.rps),
          '-c',
          String(budget.concurrency),
        ],
        undefined,
        `naabu connect ${address} (${pinnedIp}) ${String(ports.length)} port(s)`,
      );
    } catch (error) {
      if (budgetStop(error)) continue;
      throw error;
    }
    coverage.requestsUsed += ports.length;
    coverage.portsScanned += ports.length;
    coverage.hostsScanned += 1;
    deps.metrics.portsScanned.inc(ports.length);
    hosts.set(address, { ...hosts.get(address), address, status: 'scanned' });

    const probed = new Set(ports);
    const nodes = new Map<string, SurfaceNode>();
    const edges: SurfaceEdge[] = [];
    const owner = hostKey(assetId, address);
    for (const found of parseNaabu(stdout).records) {
      if (found.ip !== pinnedIp || found.proto !== 'tcp' || !probed.has(found.port)) {
        tagOutOfScope(found.ip, 'result outside the pinned address or probed ports', found.port);
        continue;
      }
      const node: SurfaceNode = {
        type: 'service',
        assetId,
        address,
        port: found.port,
        proto: 'tcp',
      };
      const key = surfaceNodeKey(node);
      if (nodes.has(key)) continue;
      nodes.set(key, node);
      edges.push({ type: 'exposes', from: owner, to: key });
      services.push({ address, port: found.port, proto: 'tcp' });
    }
    if (nodes.size > 0) {
      // A literal IP has no resolver step, so its host node is written with its first open service.
      const hostNode: SurfaceNode[] = isIp(address) ? [{ type: 'host', assetId, address }] : [];
      await write([...hostNode, ...nodes.values()], edges, provenance('naabu', SERVICE_CONFIDENCE));
      deps.metrics.servicesDiscovered.inc(nodes.size);
    }
  }
  return finish();
}
