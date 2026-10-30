import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';

import { parseScopeRules, type ScopeRulesInput } from '@blackwing/contracts';
import { hostKey, serviceKey, technologyKey, writeSurface } from '@blackwing/domain';

import {
  createInfraMetrics,
  type EnumerateDeps,
  enumerateServices,
  FINGERPRINT_BATCH_MAX,
} from './enumerate.js';
import {
  type ExecTool,
  egressSpawnOptions,
  type ReconExecutor,
  type ReconRunOptions,
} from './exec.js';
import { createReconMetrics } from './metrics.js';
import { ToolError } from '../errors.js';

import type { ProbeAuditEvent, ReconBudget } from './discover.js';

const TENANT = '01890a5d-ac96-774b-bcce-b302099a8001';
const ASSET = '01890a5d-ac96-774b-bcce-b302099a8002';
const RUN = '01890a5d-ac96-774b-bcce-b302099a8003';
const SESSION = '01890a5d-ac96-774b-bcce-b302099a8004';
const LAB_IP = '203.0.113.7';

const scopeOf = (rules: ScopeRulesInput['rules']) => parseScopeRules({ rules });
const labScope = scopeOf([
  { effect: 'include', cidr: '203.0.113.0/24', ports: [22, 80, 443, 3389] },
]);

interface Lab {
  /** ip -> open TCP ports (naabu confirms these). */
  open: Record<string, number[]>;
  /** `ip:port` -> the fingerprint row fingerprintx prints for it. */
  fingerprints: Record<string, { protocol: string; product?: string; version?: string }>;
}

const SSH = { protocol: 'ssh', product: 'OpenSSH', version: '8.9p1' };
const NGINX = { protocol: 'http', product: 'nginx', version: '1.18.0' };
const TLS_ONLY = { protocol: 'https' };
const lab: Lab = {
  open: { [LAB_IP]: [22, 80, 443] },
  fingerprints: { [`${LAB_IP}:22`]: SSH, [`${LAB_IP}:80`]: NGINX, [`${LAB_IP}:443`]: TLS_ONLY },
};

/** Fake naabu and fingerprintx; records exactly what would reach the network. */
function fakeLab(
  input: Lab,
  overrides: { fingerprintx?: (stdin: string, options: ReconRunOptions) => Promise<string> } = {},
) {
  const scans: { ip: string; ports: number[] }[] = [];
  const fingerprintTargets: string[][] = [];
  const executor: ReconExecutor = {
    run: (tool: ExecTool, args: readonly string[], options: ReconRunOptions) => {
      if (tool === 'naabu') {
        const ip = args[args.indexOf('-host') + 1] ?? '';
        const ports = (args[args.indexOf('-p') + 1] ?? '').split(',').map(Number);
        scans.push({ ip, ports });
        return Promise.resolve(
          (input.open[ip] ?? [])
            .filter((port) => ports.includes(port))
            .map((port) => JSON.stringify({ ip, port, protocol: 'tcp' }))
            .join('\n'),
        );
      }
      if (tool === 'fingerprintx') {
        const stdin = options.stdin ?? '';
        const targets = stdin.split('\n').filter((line) => line !== '');
        fingerprintTargets.push(targets);
        if (overrides.fingerprintx !== undefined) return overrides.fingerprintx(stdin, options);
        return Promise.resolve(
          targets
            .flatMap((target) => {
              const row = input.fingerprints[target];
              if (row === undefined) return [];
              const colon = target.lastIndexOf(':');
              const ip = target.slice(0, colon);
              const port = Number(target.slice(colon + 1));
              return [
                JSON.stringify({
                  ip,
                  port,
                  protocol: row.protocol,
                  ...(row.product === undefined
                    ? {}
                    : { metadata: { product: row.product, version: row.version } }),
                }),
              ];
            })
            .join('\n'),
        );
      }
      return Promise.reject(new Error(`unexpected tool ${tool}`));
    },
  };
  return { executor, scans, fingerprintTargets };
}

function harness(
  input: Lab,
  overrides: {
    scope?: ReturnType<typeof scopeOf>;
    budget?: Partial<ReconBudget>;
    signal?: AbortSignal;
    audit?: EnumerateDeps['audit'];
    fingerprintx?: (stdin: string, options: ReconRunOptions) => Promise<string>;
  } = {},
) {
  const fake = fakeLab(input, {
    ...(overrides.fingerprintx === undefined ? {} : { fingerprintx: overrides.fingerprintx }),
  });
  const scope = overrides.scope ?? labScope;
  const writes: {
    nodes: { type: string; address?: string; port?: number; product?: string }[];
    edges: { type: string; from: string; to: string }[];
    provenance: { tool: string; toolVersion: string; sourceKind: string; confidence: number };
  }[] = [];
  const audits: ProbeAuditEvent[] = [];
  const registry = new Registry();
  const deps: EnumerateDeps = {
    executor: fake.executor,
    scope,
    assetId: ASSET,
    budget: { maxRequests: 1000, rps: 20, concurrency: 5, maxHosts: 64, ...overrides.budget },
    signal: overrides.signal ?? new AbortController().signal,
    toolVersions: { dnsx: '1.2.2', naabu: '2.3.4' },
    fingerprintxVersion: '1.1.4',
    provenance: { runId: RUN, sessionId: SESSION, persona: 'infrastructure-specialist' },
    writeSurface: async (request) => {
      await writeSurface(
        {
          tenantId: TENANT,
          scope,
          audit: () => undefined,
          callTool: () => Promise.resolve({}),
        },
        request,
      );
      writes.push(request);
    },
    audit:
      overrides.audit ??
      ((event) => {
        audits.push(event);
        return Promise.resolve();
      }),
    metrics: createReconMetrics(registry),
    infraMetrics: createInfraMetrics(registry),
    now: () => '2026-10-31T10:00:00.000Z',
  };
  return {
    ...fake,
    deps,
    writes,
    audits,
    registry,
    run: (hosts: string[], ports?: number[]) =>
      enumerateServices(deps, { hosts, ...(ports === undefined ? {} : { ports }) }),
  };
}

describe('enumerateServices', () => {
  it('confirms services with naabu and fingerprints them on the pinned IP, de-duplicated, with provenance', async () => {
    // Duplicate fingerprint rows (a misbehaving tool) must not produce duplicate technology.
    const printer = fakeLab(lab).executor;
    const h = harness(lab, {
      fingerprintx: async (stdin, options) => {
        const out = await printer.run('fingerprintx', ['--json'], { ...options, stdin });
        return `${out}\n${out}`;
      },
    });
    const result = await h.run([LAB_IP], [22, 80, 443]);

    expect(result.discovery.services.map((s) => s.port)).toEqual([22, 80, 443]);
    expect(h.fingerprintTargets).toEqual([[`${LAB_IP}:22`, `${LAB_IP}:80`, `${LAB_IP}:443`]]);
    expect(result.technologies).toEqual([
      {
        address: LAB_IP,
        port: 22,
        proto: 'tcp',
        product: 'OpenSSH',
        version: '8.9p1',
        confidence: 0.85,
      },
      {
        address: LAB_IP,
        port: 80,
        proto: 'tcp',
        product: 'nginx',
        version: '1.18.0',
        confidence: 0.85,
      },
      { address: LAB_IP, port: 443, proto: 'tcp', product: 'https', confidence: 0.7 },
    ]);
    expect(result.coverage).toMatchObject({
      servicesConfirmed: 3,
      servicesOutOfScope: 0,
      servicesFingerprinted: 3,
      recordsUnmatched: 0,
      halted: null,
    });

    const tech = h.writes.flatMap((w) => w.nodes.filter((n) => n.type === 'technology'));
    expect(tech.map((n) => n.product).sort()).toEqual(['OpenSSH', 'https', 'nginx']);
    const provenance = h.writes.map((w) => w.provenance).filter((p) => p.tool === 'fingerprintx');
    expect(provenance).toEqual([
      expect.objectContaining({
        tool: 'fingerprintx',
        toolVersion: '1.1.4',
        sourceKind: 'active',
        confidence: 0.85,
      }),
      expect.objectContaining({
        tool: 'fingerprintx',
        toolVersion: '1.1.4',
        sourceKind: 'active',
        confidence: 0.7,
      }),
    ]);
    const hostId = hostKey(ASSET, LAB_IP);
    expect(h.writes.flatMap((w) => w.edges)).toContainEqual({
      type: 'runs',
      from: serviceKey(hostId, 22, 'tcp'),
      to: technologyKey(hostId, 'OpenSSH', '8.9p1'),
    });
    // Observations only: no verdict field, every technology is marked active and below full confidence.
    for (const w of h.writes) expect(w.provenance.confidence).toBeLessThan(1);
  });

  it('records every naabu-confirmed service and every fingerprint in the infra metrics', async () => {
    const h = harness(lab);
    await h.run([LAB_IP], [22, 80, 443]);
    const text = await h.registry.getSingleMetricAsString('infra_services_confirmed_total');
    expect(text).toMatch(/infra_services_confirmed_total 3/);
    const fingerprints = await h.registry.getSingleMetricAsString('infra_fingerprints_total');
    expect(fingerprints).toMatch(/infra_fingerprints_total 3/);
  });

  it('never sends a port outside the scope to the fingerprinter', async () => {
    const h = harness({ open: { [LAB_IP]: [22, 8080, 3389] }, fingerprints: lab.fingerprints });
    const result = await h.run([LAB_IP], [22, 8080]);
    expect(h.scans).toEqual([{ ip: LAB_IP, ports: [22] }]);
    expect(h.fingerprintTargets.flat()).toEqual([`${LAB_IP}:22`]);
    expect(h.fingerprintTargets.flat()).not.toContain(`${LAB_IP}:8080`);
    expect(result.technologies.map((t) => t.port)).toEqual([22]);
  });

  it('halts cleanly when the request budget is spent by naabu, fingerprinting nothing further', async () => {
    const h = harness(lab, { budget: { maxRequests: 3 } });
    const result = await h.run([LAB_IP], [22, 80, 443]);
    expect(h.fingerprintTargets).toEqual([]);
    expect(result.technologies).toEqual([]);
    expect(result.coverage).toMatchObject({ servicesFingerprinted: 0, halted: 'budget' });
  });

  it('fingerprints only the services the remaining budget covers and halts with the budget reason', async () => {
    const h = harness(lab, { budget: { maxRequests: 4 } });
    const result = await h.run([LAB_IP], [22, 80, 443]);
    expect(h.fingerprintTargets).toEqual([[`${LAB_IP}:22`]]);
    expect(result.technologies.map((t) => t.port)).toEqual([22]);
    expect(result.coverage).toMatchObject({
      servicesFingerprinted: 1,
      requestsUsed: 1,
      halted: 'budget',
    });
  });

  it('chunks large service sets and keeps earlier chunks when a later one hits a gateway budget signal', async () => {
    const ports = Array.from({ length: FINGERPRINT_BATCH_MAX + 10 }, (_, i) => i + 1);
    const fingerprints = Object.fromEntries(
      ports.map((port) => [`${LAB_IP}:${String(port)}`, { protocol: 'tcp-svc' }]),
    );
    let batch = 0;
    const h = harness(
      { open: { [LAB_IP]: ports }, fingerprints },
      {
        scope: scopeOf([{ effect: 'include', cidr: '203.0.113.0/24' }]),
        fingerprintx: (stdin, options) => {
          batch += 1;
          if (batch === 2) return Promise.reject(new ToolError('TOOL_BUDGET_EXCEEDED', 'budget'));
          return fakeLab({ open: {}, fingerprints }).executor.run('fingerprintx', ['--json'], {
            ...options,
            stdin,
          });
        },
      },
    );
    const result = await h.run([LAB_IP], ports);
    expect(h.fingerprintTargets.map((targets) => targets.length)).toEqual([
      FINGERPRINT_BATCH_MAX,
      10,
    ]);
    expect(result.technologies).toHaveLength(FINGERPRINT_BATCH_MAX);
    expect(result.coverage.halted).toBe('budget_signal');
    expect(
      h.audits.filter((a) => a.tool === 'fingerprintx').map((a) => [a.outcome, a.code]),
    ).toEqual([
      ['success', null],
      ['error', 'TOOL_BUDGET_EXCEEDED'],
    ]);
  });

  it('fails with TOOL_KILLED and writes nothing when the run is killed during fingerprinting', async () => {
    const controller = new AbortController();
    const h = harness(lab, {
      signal: controller.signal,
      fingerprintx: () => {
        controller.abort();
        return Promise.resolve(JSON.stringify({ ip: LAB_IP, port: 22, protocol: 'ssh' }));
      },
    });
    await expect(h.run([LAB_IP], [22])).rejects.toMatchObject({ code: 'TOOL_KILLED' });
    expect(h.writes.flatMap((w) => w.nodes).filter((n) => n.type === 'technology')).toEqual([]);
  });

  it('maps a fingerprintx failure to a fixed TOOL_BACKEND_UNAVAILABLE and audits it', async () => {
    const h = harness(lab, {
      fingerprintx: () => Promise.reject(new Error('stack trace with /secret/path')),
    });
    await expect(h.run([LAB_IP], [22])).rejects.toMatchObject({
      code: 'TOOL_BACKEND_UNAVAILABLE',
      message: 'fingerprintx failed',
    });
    expect(h.audits.at(-1)).toMatchObject({
      tool: 'fingerprintx',
      outcome: 'error',
      code: 'TOOL_BACKEND_UNAVAILABLE',
    });
  });

  it('fails closed when a fingerprint batch cannot be audited: the tool result is not written', async () => {
    const h = harness(lab, {
      audit: (event) =>
        event.tool === 'fingerprintx'
          ? Promise.reject(new ToolError('TOOL_BACKEND_UNAVAILABLE', 'down'))
          : Promise.resolve(),
    });
    await expect(h.run([LAB_IP], [22])).rejects.toMatchObject({ code: 'TOOL_BACKEND_UNAVAILABLE' });
    expect(h.writes.flatMap((w) => w.nodes).filter((n) => n.type === 'technology')).toEqual([]);
  });

  it('drops fingerprint rows for services it did not ask about and never writes them', async () => {
    const h = harness(lab, {
      fingerprintx: () =>
        Promise.resolve(
          [
            JSON.stringify({ ip: LAB_IP, port: 3389, protocol: 'rdp' }),
            JSON.stringify({ ip: '203.0.113.99', port: 22, protocol: 'ssh' }),
            JSON.stringify({
              ip: LAB_IP,
              port: 22,
              protocol: 'ssh',
              metadata: { product: 'OpenSSH' },
            }),
          ].join('\n'),
        ),
    });
    const result = await h.run([LAB_IP], [22]);
    expect(result.coverage.recordsUnmatched).toBe(2);
    expect(result.technologies.map((t) => `${t.port}:${t.product}`)).toEqual(['22:OpenSSH']);
  });

  it('uses the same egress forcing for fingerprintx as for the other binaries', () => {
    const options = egressSpawnOptions('http://gateway.internal:3128');
    expect(options.commands?.fingerprintx).toEqual([
      'proxychains4',
      '-q',
      '-f',
      '/etc/proxychains/blackwing.conf',
      'fingerprintx',
    ]);
  });
});
