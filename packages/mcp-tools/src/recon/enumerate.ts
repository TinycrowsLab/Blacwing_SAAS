import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Counter, type Registry } from 'prom-client';

import { normaliseIp } from '@blackwing/contracts';
import {
  hostKey,
  matchScope,
  serviceKey,
  type SurfaceEdge,
  type SurfaceNode,
  type SurfaceProvenance,
  technologyKey,
} from '@blackwing/domain';

import {
  discoverServices,
  type DiscoverDeps,
  type DiscoverResult,
  type DiscoverServicesInput,
  type ProbeAuditEvent,
} from './discover.js';
import { ToolError } from '../errors.js';
import { parseFingerprintx } from './parse.js';

/**
 * Infrastructure service enumeration (INFRASPEC-003). Confirms the listening services of in-scope hosts with
 * naabu (through `discoverServices`, RECON-007) and fingerprints each confirmed service with fingerprintx. Only
 * the pinned IP of a host is ever probed, on ports the scope matcher allows, within the per-test-case budget.
 * Fingerprints are observations: a product or version is recorded as `technology` with provenance and a
 * confidence, and is never a verdict that a service is vulnerable (INFRASPEC-006 owns that).
 */

const TRACER = 'blackwing.mcp-tools';
const TOOL_TIMEOUT_MS = 120_000;
const SUMMARY_MAX = 512;
/** Targets per fingerprintx run; larger sets are chunked so one run and one audit event stay bounded. */
export const FINGERPRINT_BATCH_MAX = 50;
/** A product (and version, when disclosed) was read from the banner. */
const PRODUCT_CONFIDENCE = 0.85;
/** Only the protocol was identified; no product name was disclosed. */
const PROTOCOL_CONFIDENCE = 0.7;

const tracer = trace.getTracer(TRACER);

/** `infra_services_confirmed_total` and `infra_fingerprints_total` (INFRASPEC-003 observability). */
export interface InfraMetrics {
  readonly servicesConfirmed: Counter;
  readonly fingerprints: Counter;
}

export function createInfraMetrics(registry: Registry): InfraMetrics {
  return {
    servicesConfirmed: new Counter({
      name: 'infra_services_confirmed_total',
      help: 'Listening services confirmed by naabu during infrastructure enumeration.',
      registers: [registry],
    }),
    fingerprints: new Counter({
      name: 'infra_fingerprints_total',
      help: 'Technology nodes written from fingerprintx observations.',
      registers: [registry],
    }),
  };
}

export interface EnumerateDeps extends DiscoverDeps {
  /** Pinned fingerprintx version of the run (§8.9). */
  readonly fingerprintxVersion: string;
  readonly infraMetrics: InfraMetrics;
}

export interface FingerprintedTechnology {
  readonly address: string;
  readonly port: number;
  readonly proto: 'tcp';
  readonly product: string;
  readonly version?: string;
  readonly confidence: number;
}

export interface EnumerateResult {
  readonly discovery: DiscoverResult;
  /** De-duplicated technology observations written to the surface model. */
  readonly technologies: readonly FingerprintedTechnology[];
  readonly coverage: {
    readonly servicesConfirmed: number;
    /** Confirmed services that were out of scope at fingerprint time: never probed. */
    readonly servicesOutOfScope: number;
    readonly servicesFingerprinted: number;
    readonly requestsUsed: number;
    readonly recordsUnmatched: number;
    /** Why fingerprinting stopped early; `null` when every in-scope service was probed. */
    readonly halted: 'budget' | 'budget_signal' | null;
  };
}

interface Target {
  readonly address: string;
  readonly ip: string;
  readonly port: number;
}

/**
 * Confirms the services of `input` with naabu, then fingerprints each confirmed service on its pinned IP with the
 * budget that naabu left. A budget stop (the request cap, or the gateway's 4xx signal) ends the stage cleanly and is
 * reported in `coverage.halted`. A kill, or a tool or audit failure, propagates.
 * @throws {ToolError} `TOOL_KILLED`, `TOOL_BACKEND_UNAVAILABLE` (tool or audit failure), or the surface write error.
 */
export async function enumerateServices(
  deps: EnumerateDeps,
  input: DiscoverServicesInput,
): Promise<EnumerateResult> {
  const discovery = await discoverServices(deps, input);
  deps.infraMetrics.servicesConfirmed.inc(discovery.services.length);

  const pinnedOf = new Map(
    discovery.hosts.flatMap((host) =>
      host.pinnedIp === undefined ? [] : [[host.address, host.pinnedIp] as const],
    ),
  );
  const ipOf = (address: string): string | undefined =>
    normaliseIp(address) ?? pinnedOf.get(address);

  // Naabu's confirmed services become fingerprint targets, pinned IP only.
  const candidates: Target[] = [];
  for (const service of discovery.services) {
    const ip = ipOf(service.address);
    if (ip !== undefined) candidates.push({ address: service.address, ip, port: service.port });
  }

  // Scope first: a service outside the envelope is never sent to the fingerprinter.
  const inScope = candidates.filter(
    (target) => matchScope({ ip: target.ip, port: target.port }, deps.scope).inScope,
  );

  const coverage = {
    servicesConfirmed: discovery.services.length,
    servicesOutOfScope: candidates.length - inScope.length,
    servicesFingerprinted: 0,
    requestsUsed: 0,
    /** Fingerprint rows that named no service asked for in their run: dropped, never written. */
    recordsUnmatched: 0,
    halted: null as EnumerateResult['coverage']['halted'],
  };
  const technologies: FingerprintedTechnology[] = [];
  const seen = new Set<string>();

  if (discovery.coverage.halted === 'budget_signal') {
    coverage.halted = 'budget_signal';
    return { discovery, technologies, coverage };
  }
  const remaining = Math.max(0, deps.budget.maxRequests - discovery.coverage.requestsUsed);
  const budgeted = inScope.slice(0, remaining);
  if (budgeted.length < inScope.length) coverage.halted = 'budget';

  for (let at = 0; at < budgeted.length; at += FINGERPRINT_BATCH_MAX) {
    const batch = budgeted.slice(at, at + FINGERPRINT_BATCH_MAX);
    let stdout: string;
    try {
      stdout = await runFingerprintx(deps, batch);
    } catch (error) {
      if (error instanceof ToolError && error.code === 'TOOL_BUDGET_EXCEEDED') {
        coverage.halted = 'budget_signal';
        break;
      }
      throw error;
    }
    coverage.requestsUsed += batch.length;
    coverage.servicesFingerprinted += batch.length;

    const asked = new Map(batch.map((target) => [`${target.ip}:${String(target.port)}`, target]));
    const fresh: FingerprintedTechnology[] = [];
    for (const found of parseFingerprintx(stdout).records) {
      const target = asked.get(`${found.ip}:${String(found.port)}`);
      if (target === undefined) {
        coverage.recordsUnmatched += 1;
        continue;
      }
      const product = found.product ?? found.protocol;
      const version = found.product === null ? undefined : (found.version ?? undefined);
      const confidence = found.product === null ? PROTOCOL_CONFIDENCE : PRODUCT_CONFIDENCE;
      const identity = `${target.address}|${String(target.port)}|${product.toLowerCase()}|${version ?? ''}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      fresh.push({
        address: target.address,
        port: target.port,
        proto: 'tcp',
        product,
        ...(version === undefined ? {} : { version }),
        confidence,
      });
    }
    technologies.push(...fresh);
    await writeTechnologies(deps, fresh);
    deps.infraMetrics.fingerprints.inc(fresh.length);
  }

  return { discovery, technologies, coverage };
}

/** One fingerprintx run over a batch of pinned targets, audited and traced whether it worked or not. */
async function runFingerprintx(deps: EnumerateDeps, batch: readonly Target[]): Promise<string> {
  const { signal } = deps;
  // A call, so TypeScript does not narrow the flag across the await (the kill can land while fingerprintx runs).
  const killedNow = (): boolean => signal.aborted;
  if (killedNow()) throw new ToolError('TOOL_KILLED', 'the run was killed');
  const inputSummary = `fingerprintx ${String(batch.length)} service(s)`;
  const span = tracer.startSpan('tool.fingerprintx', {
    attributes: { 'recon.tool': 'fingerprintx' },
  });
  const started = Date.now();
  let stdout = '';
  let failure: ToolError | undefined;
  try {
    stdout = await deps.executor.run('fingerprintx', ['--json'], {
      stdin: `${batch.map((target) => `${target.ip}:${String(target.port)}`).join('\n')}\n`,
      signal,
      timeoutMs: TOOL_TIMEOUT_MS,
    });
    if (killedNow()) throw new ToolError('TOOL_KILLED', 'the run was killed');
  } catch (error) {
    failure = killedNow()
      ? new ToolError('TOOL_KILLED', 'the run was killed')
      : error instanceof ToolError
        ? error
        : new ToolError('TOOL_BACKEND_UNAVAILABLE', 'fingerprintx failed');
    span.setStatus({ code: SpanStatusCode.ERROR, message: failure.code });
  } finally {
    span.end();
  }
  const event: ProbeAuditEvent = {
    tool: 'fingerprintx',
    inputSummary: inputSummary.slice(0, SUMMARY_MAX),
    durationMs: Date.now() - started,
    outputBytes: Buffer.byteLength(stdout, 'utf8'),
    outcome: failure === undefined ? 'success' : 'error',
    code: failure?.code ?? null,
  };
  await deps.audit(event);
  if (failure !== undefined) throw failure;
  return stdout;
}

/** Writes one batch of technology nodes and their `runs` edges, grouped by confidence (one provenance per write). */
async function writeTechnologies(
  deps: EnumerateDeps,
  technologies: readonly FingerprintedTechnology[],
): Promise<void> {
  const now = deps.now ?? ((): string => new Date().toISOString());
  for (const confidence of [PRODUCT_CONFIDENCE, PROTOCOL_CONFIDENCE]) {
    const group = technologies.filter((tech) => tech.confidence === confidence);
    if (group.length === 0) continue;
    const nodes: SurfaceNode[] = [];
    const edges: SurfaceEdge[] = [];
    for (const tech of group) {
      const host = hostKey(deps.assetId, tech.address);
      nodes.push({
        type: 'technology',
        assetId: deps.assetId,
        address: tech.address,
        product: tech.product,
        ...(tech.version === undefined ? {} : { version: tech.version }),
      });
      edges.push({
        type: 'runs',
        from: serviceKey(host, tech.port, tech.proto),
        to: technologyKey(host, tech.product, tech.version),
      });
    }
    const provenance: SurfaceProvenance = {
      ...deps.provenance,
      tool: 'fingerprintx',
      toolVersion: deps.fingerprintxVersion,
      sourceKind: 'active',
      confidence,
      observedAt: now(),
    };
    await deps.writeSurface({ nodes, edges, provenance });
  }
}
