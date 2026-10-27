import { Registry } from 'prom-client';
import { describe, expect, it, vi } from 'vitest';

import { parseScopeRules, type ScopeRulesInput } from '@blackwing/contracts';
import { hostKey, serviceKey, writeSurface } from '@blackwing/domain';

import {
  COMMON_PORTS,
  type DiscoverDeps,
  type DiscoverServicesInput,
  discoverServices,
  discoverServicesInputSchema,
  type ProbeAuditEvent,
  type ReconBudget,
} from './discover.js';
import { createReconMetrics } from './metrics.js';
import { ToolError } from '../errors.js';

import type { ReconExecutor, ReconRunOptions, ReconTool } from './exec.js';

const TENANT = '01890a5d-ac96-774b-bcce-b302099a8001';
const ASSET = '01890a5d-ac96-774b-bcce-b302099a8002';
const RUN = '01890a5d-ac96-774b-bcce-b302099a8003';
const SESSION = '01890a5d-ac96-774b-bcce-b302099a8004';
const WEB_IP = '203.0.113.7';
const API_IP = '203.0.113.8';

const scopeOf = (rules: ScopeRulesInput['rules']) => parseScopeRules({ rules });
const labScope = scopeOf([
  { effect: 'include', host: '*.lab.example', ports: [80, 443, 8080, 3000] },
  { effect: 'include', host: 'lab.example', ports: [80, 443] },
  { effect: 'exclude', host: 'admin.lab.example' },
]);

interface Lab {
  /** name -> answers handed out by the resolver, per lookup number. */
  dns: Record<string, string[] | ((lookup: number) => string[])>;
  /** ip -> open TCP ports. */
  open: Record<string, number[]>;
  /** Extra naabu lines the tool prints regardless of what was asked (a misbehaving scanner). */
  rogue?: Record<string, object[]>;
}

/** A fake dnsx/naabu pair; records exactly what would reach the network. */
function fakeLab(lab: Lab) {
  const lookups: string[][] = [];
  const scans: { ip: string; ports: number[] }[] = [];
  let lookupNumber = 0;
  const hook = { naabu: undefined as undefined | ((options: ReconRunOptions) => void) };
  const executor: ReconExecutor = {
    run: (tool: ReconTool, args: readonly string[], options: ReconRunOptions) => {
      if (tool === 'dnsx') {
        const names = (options.stdin ?? '').split('\n').filter((n) => n !== '');
        lookups.push(names);
        lookupNumber += 1;
        const lines = names.flatMap((host) => {
          const answer = lab.dns[host];
          const ips = typeof answer === 'function' ? answer(lookupNumber) : answer;
          return ips === undefined || ips.length === 0
            ? []
            : [JSON.stringify({ host, a: ips, status_code: 'NOERROR' })];
        });
        return Promise.resolve(lines.join('\n'));
      }
      hook.naabu?.(options);
      const ip = args[args.indexOf('-host') + 1] ?? '';
      const ports = (args[args.indexOf('-p') + 1] ?? '').split(',').map(Number);
      scans.push({ ip, ports });
      const lines = [
        ...(lab.open[ip] ?? [])
          .filter((port) => ports.includes(port))
          .map((port) => ({ ip, port, protocol: 'tcp' })),
        ...(lab.rogue?.[ip] ?? []),
      ];
      return Promise.resolve(lines.map((line) => JSON.stringify(line)).join('\n'));
    },
  };
  return { executor, lookups, scans, hook };
}

function harness(
  lab: Lab,
  overrides: {
    scope?: ReturnType<typeof scopeOf>;
    budget?: Partial<ReconBudget>;
    signal?: AbortSignal;
    audit?: DiscoverDeps['audit'];
    executor?: ReconExecutor;
  } = {},
) {
  const fake = fakeLab(lab);
  const scope = overrides.scope ?? labScope;
  const writes: { nodes: { type: string; address: string; port?: number }[]; edges: unknown[] }[] =
    [];
  const calls: unknown[] = [];
  const audits: ProbeAuditEvent[] = [];
  const registry = new Registry();
  const deps: DiscoverDeps = {
    executor: overrides.executor ?? fake.executor,
    scope,
    assetId: ASSET,
    budget: { maxRequests: 1000, rps: 20, concurrency: 5, maxHosts: 64, ...overrides.budget },
    signal: overrides.signal ?? new AbortController().signal,
    toolVersions: { dnsx: '1.2.2', naabu: '2.3.4' },
    provenance: { runId: RUN, sessionId: SESSION, persona: 'active-recon' },
    // The real domain write: schema, tenant context and scope check on every node.
    writeSurface: async (request) => {
      await writeSurface(
        {
          tenantId: TENANT,
          scope,
          audit: () => undefined,
          callTool: (_tool, input) => {
            calls.push(input);
            return Promise.resolve({});
          },
        },
        request,
      );
      writes.push(request as (typeof writes)[number]);
    },
    audit:
      overrides.audit ??
      ((event) => {
        audits.push(event);
        return Promise.resolve();
      }),
    metrics: createReconMetrics(registry),
    now: () => '2026-10-28T10:00:00.000Z',
  };
  const run = (input: DiscoverServicesInput) => discoverServices(deps, input);
  return { ...fake, deps, run, writes, calls, audits, registry };
}

const labTargets: Lab = {
  dns: { 'www.lab.example': [WEB_IP], 'api.lab.example': [API_IP] },
  open: { [WEB_IP]: [80, 443, 22, 3306], [API_IP]: [8080] },
};

describe('discoverServices', () => {
  it('resolves in-scope names, pins the answer and writes host and service nodes with provenance', async () => {
    const h = harness(labTargets);
    const result = await h.run({
      hosts: ['WWW.lab.example', 'api.lab.example', 'www.lab.example'],
    });

    expect(h.lookups).toEqual([['www.lab.example', 'api.lab.example']]);
    expect(result.hosts).toEqual([
      { address: 'www.lab.example', status: 'scanned', pinnedIp: WEB_IP },
      { address: 'api.lab.example', status: 'scanned', pinnedIp: API_IP },
    ]);
    // 22 and 3306 are open but the scope never allowed them: they are neither probed nor reported.
    expect(result.services).toEqual([
      { address: 'www.lab.example', port: 80, proto: 'tcp' },
      { address: 'www.lab.example', port: 443, proto: 'tcp' },
      { address: 'api.lab.example', port: 8080, proto: 'tcp' },
    ]);
    expect(h.scans).toEqual([
      { ip: WEB_IP, ports: [80, 443, 3000, 8080] },
      { ip: API_IP, ports: [80, 443, 3000, 8080] },
    ]);

    const [hostBatch, webBatch, apiBatch] = h.writes;
    expect(hostBatch?.nodes).toEqual([
      { type: 'host', assetId: ASSET, address: 'www.lab.example', pinnedIp: WEB_IP },
      { type: 'host', assetId: ASSET, address: 'api.lab.example', pinnedIp: API_IP },
    ]);
    expect(webBatch?.nodes.map((n) => [n.type, n.port])).toEqual([
      ['service', 80],
      ['service', 443],
    ]);
    const webHost = hostKey(ASSET, 'www.lab.example');
    expect(webBatch?.edges).toEqual([
      { type: 'exposes', from: webHost, to: serviceKey(webHost, 80, 'tcp') },
      { type: 'exposes', from: webHost, to: serviceKey(webHost, 443, 'tcp') },
    ]);
    expect(apiBatch?.nodes).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      tenantId: TENANT,
      request: {
        provenance: {
          runId: RUN,
          sessionId: SESSION,
          persona: 'active-recon',
          tool: 'dnsx',
          toolVersion: '1.2.2',
          confidence: 0.95,
          observedAt: '2026-10-28T10:00:00.000Z',
        },
      },
    });
    expect(h.calls[1]).toMatchObject({
      request: { provenance: { tool: 'naabu', toolVersion: '2.3.4', confidence: 0.9 } },
    });
    expect(result.coverage).toMatchObject({
      hostsRequested: 2,
      hostsResolved: 2,
      hostsScanned: 2,
      portsScanned: 8,
      requestsUsed: 10,
      truncated: false,
      halted: null,
    });
    const metrics = await h.registry.metrics();
    expect(metrics).toContain('recon_services_discovered_total 3');
    expect(metrics).toContain('recon_ports_scanned_total 8');
  });

  it('de-duplicates repeated scanner lines by surface key', async () => {
    const h = harness({
      ...labTargets,
      rogue: {
        [WEB_IP]: [
          { ip: WEB_IP, port: 80 },
          { ip: WEB_IP, port: 80, protocol: 'tcp' },
        ],
      },
    });
    const result = await h.run({ hosts: ['www.lab.example'] });
    expect(result.services.filter((s) => s.port === 80)).toHaveLength(1);
    expect(h.writes[1]?.nodes).toHaveLength(2);
  });

  it('never resolves or probes an out-of-scope or excluded name', async () => {
    const h = harness({
      ...labTargets,
      dns: { ...labTargets.dns, 'admin.lab.example': [WEB_IP], 'evil.example': [WEB_IP] },
    });
    const result = await h.run({
      hosts: ['www.lab.example', 'admin.lab.example', 'evil.example'],
    });
    expect(h.lookups).toEqual([['www.lab.example']]);
    expect(h.scans.map((s) => s.ip)).toEqual([WEB_IP]);
    expect(result.hosts.filter((x) => x.status === 'out_of_scope').map((x) => x.address)).toEqual([
      'admin.lab.example',
      'evil.example',
    ]);
    expect(result.outOfScopeCount).toBe(2);
  });

  it('probes only scope-allowed ports: an out-of-scope port never reaches the target', async () => {
    const h = harness({
      dns: { 'www.lab.example': [WEB_IP], 'lab.example': [API_IP] },
      open: { [WEB_IP]: [80, 22, 8080], [API_IP]: [80, 8080] },
    });
    // 22 is outside every rule; 8080 is allowed on *.lab.example but not on lab.example.
    const result = await h.run({
      hosts: ['www.lab.example', 'lab.example'],
      ports: [22, 80, 8080, 2375],
    });
    expect(h.scans).toEqual([
      { ip: WEB_IP, ports: [80, 8080] },
      { ip: API_IP, ports: [80] },
    ]);
    const allProbed = h.scans.flatMap((s) => s.ports);
    expect(allProbed).not.toContain(22);
    expect(allProbed).not.toContain(2375);
    expect(result.coverage.portsSkippedOutOfScope).toBe(2 + 3);
    expect(result.services.map((s) => `${s.address}:${String(s.port)}`)).toEqual([
      'www.lab.example:80',
      'www.lab.example:8080',
      'lab.example:80',
    ]);
  });

  it('tags scanner output outside the pinned IP or probed ports as out_of_scope and does not persist it', async () => {
    const h = harness({
      ...labTargets,
      rogue: {
        [WEB_IP]: [
          { ip: '198.51.100.99', port: 80 },
          { ip: WEB_IP, port: 22 },
          { ip: WEB_IP, port: 80, protocol: 'udp' },
        ],
      },
    });
    const result = await h.run({ hosts: ['www.lab.example'] });
    expect(result.outOfScopeCount).toBe(3);
    expect(result.outOfScope.map((o) => [o.address, o.port])).toEqual([
      ['198.51.100.99', 80],
      [WEB_IP, 22],
      [WEB_IP, 80],
    ]);
    expect(result.services.map((s) => s.port)).toEqual([80, 443]);
    expect(JSON.stringify(h.writes)).not.toContain('198.51.100.99');
  });

  describe('anti-rebinding', () => {
    it('pins the first allowed answer and skips private ones', async () => {
      const h = harness({ ...labTargets, dns: { 'www.lab.example': ['10.0.0.5', WEB_IP] } });
      const result = await h.run({ hosts: ['www.lab.example'] });
      expect(result.hosts[0]).toMatchObject({ pinnedIp: WEB_IP, status: 'scanned' });
      expect(h.scans.map((s) => s.ip)).toEqual([WEB_IP]);
    });

    it('blocks a name whose every answer is private, loopback or metadata, and probes nothing', async () => {
      for (const answer of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '::1', 'fd00::1']) {
        const h = harness({ ...labTargets, dns: { 'www.lab.example': [answer] } });
        const result = await h.run({ hosts: ['www.lab.example'] });
        expect(result.hosts).toEqual([{ address: 'www.lab.example', status: 'blocked' }]);
        expect(h.scans).toEqual([]);
        expect(h.writes).toEqual([]);
        expect(result.outOfScopeCount).toBe(1);
      }
    });

    it('resolves once: an answer that flips to a private IP later is never seen or used', async () => {
      const h = harness({
        ...labTargets,
        dns: { 'www.lab.example': (lookup) => (lookup === 1 ? [WEB_IP] : ['169.254.169.254']) },
      });
      await h.run({ hosts: ['www.lab.example'] });
      expect(h.lookups).toHaveLength(1);
      expect(h.scans).toEqual([{ ip: WEB_IP, ports: expect.any(Array) as number[] }]);
    });

    it('allows a private answer only when a CIDR include covers it, and honours a CIDR exclude', async () => {
      const scope = scopeOf([
        { effect: 'include', host: '*.lab.example' },
        { effect: 'include', cidr: '10.20.0.0/16' },
        { effect: 'exclude', cidr: '203.0.113.0/24' },
      ]);
      const lab: Lab = {
        dns: {
          'in.lab.example': ['10.20.1.1'],
          'out.lab.example': ['10.99.1.1'],
          'ex.lab.example': [WEB_IP],
        },
        open: { '10.20.1.1': [80], '10.99.1.1': [80], [WEB_IP]: [80] },
      };
      const h = harness(lab, { scope });
      const result = await h.run({
        hosts: ['in.lab.example', 'out.lab.example', 'ex.lab.example'],
        ports: [80],
      });
      expect(result.hosts.map((x) => [x.address, x.status])).toEqual([
        ['in.lab.example', 'scanned'],
        ['out.lab.example', 'blocked'],
        ['ex.lab.example', 'blocked'],
      ]);
      expect(h.scans.map((s) => s.ip)).toEqual(['10.20.1.1']);
    });
  });

  describe('IP literal targets', () => {
    const scope = scopeOf([{ effect: 'include', cidr: '203.0.113.0/28', ports: [80] }]);

    it('probes an in-scope IP without resolving and writes its host node with its services', async () => {
      const h = harness({ dns: {}, open: { [WEB_IP]: [80] } }, { scope });
      const result = await h.run({ hosts: [WEB_IP] });
      expect(h.lookups).toEqual([]);
      expect(result.services).toEqual([{ address: WEB_IP, port: 80, proto: 'tcp' }]);
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]?.nodes.map((n) => n.type)).toEqual(['host', 'service']);
    });

    it('never probes an IP outside the CIDR', async () => {
      const h = harness({ dns: {}, open: { '203.0.113.99': [80] } }, { scope });
      const result = await h.run({ hosts: ['203.0.113.99'] });
      expect(h.scans).toEqual([]);
      expect(result.hosts).toEqual([{ address: '203.0.113.99', status: 'out_of_scope' }]);
    });
  });

  it('succeeds with zero services when the host is down or every port is filtered', async () => {
    const h = harness({ dns: { 'www.lab.example': [WEB_IP], 'gone.lab.example': [] }, open: {} });
    const result = await h.run({ hosts: ['www.lab.example', 'gone.lab.example'] });
    expect(result.services).toEqual([]);
    expect(result.hosts).toEqual([
      { address: 'www.lab.example', status: 'scanned', pinnedIp: WEB_IP },
      { address: 'gone.lab.example', status: 'unresolved' },
    ]);
    expect(result.coverage.halted).toBeNull();
    // The resolved host is still recorded; only the batch of services is empty.
    expect(h.writes).toHaveLength(1);
  });

  describe('budget', () => {
    it('halts when the request budget is spent and records partial coverage', async () => {
      const h = harness(labTargets, { budget: { maxRequests: 2 + 4 + 1 } });
      const result = await h.run({ hosts: ['www.lab.example', 'api.lab.example'] });
      expect(result.coverage).toMatchObject({
        hostsScanned: 2,
        portsScanned: 5,
        requestsUsed: 7,
        halted: 'budget',
      });
      expect(h.scans[1]?.ports).toEqual([80]);
      expect(h.scans.flatMap((s) => s.ports)).toHaveLength(5);
    });

    it('leaves later hosts skipped once the budget is exhausted', async () => {
      const h = harness(labTargets, { budget: { maxRequests: 2 + 4 } });
      const result = await h.run({ hosts: ['www.lab.example', 'api.lab.example'] });
      expect(result.coverage.halted).toBe('budget');
      expect(result.hosts).toEqual([
        { address: 'www.lab.example', status: 'scanned', pinnedIp: WEB_IP },
        { address: 'api.lab.example', status: 'skipped', pinnedIp: API_IP },
      ]);
      expect(h.scans).toHaveLength(1);
      expect(result.services.map((s) => s.port)).toEqual([80, 443]);
    });

    it('does not even resolve more names than the budget allows', async () => {
      const h = harness(labTargets, { budget: { maxRequests: 1 } });
      const result = await h.run({ hosts: ['www.lab.example', 'api.lab.example'] });
      expect(h.lookups).toEqual([['www.lab.example']]);
      expect(h.scans).toEqual([]);
      expect(result.coverage).toMatchObject({ halted: 'budget', requestsUsed: 1 });
    });

    it('stops cleanly on a gateway budget signal and keeps what was already found', async () => {
      const h = harness(labTargets);
      const inner = h.deps.executor;
      let scans = 0;
      const executor: ReconExecutor = {
        run: (tool, args, options) => {
          if (tool === 'naabu' && (scans += 1) === 2) {
            return Promise.reject(new ToolError('TOOL_BUDGET_EXCEEDED', 'budget'));
          }
          return inner.run(tool, args, options);
        },
      };
      const result = await discoverServices(
        { ...h.deps, executor },
        { hosts: ['www.lab.example', 'api.lab.example'] },
      );
      expect(result.coverage.halted).toBe('budget_signal');
      expect(result.services.map((s) => s.port)).toEqual([80, 443]);
      expect(h.audits.map((a) => [a.tool, a.outcome, a.code])).toEqual([
        ['dnsx', 'success', null],
        ['naabu', 'success', null],
        ['naabu', 'error', 'TOOL_BUDGET_EXCEEDED'],
      ]);
    });

    it('caps the host list (wildcard DNS guard) and flags the truncation', async () => {
      const dns = Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`h${String(i)}.lab.example`, [WEB_IP]]),
      );
      const h = harness({ dns, open: {} }, { budget: { maxHosts: 2 } });
      const result = await h.run({ hosts: Object.keys(dns) });
      expect(h.lookups).toEqual([['h0.lab.example', 'h1.lab.example']]);
      expect(result.coverage).toMatchObject({ hostsRequested: 5, truncated: true });
      expect(result.hosts).toHaveLength(2);
    });
  });

  describe('kill switch and failures', () => {
    it('fails with TOOL_KILLED before any probe when the run is already killed', async () => {
      const controller = new AbortController();
      controller.abort();
      const h = harness(labTargets, { signal: controller.signal });
      await expect(h.run({ hosts: ['www.lab.example'] })).rejects.toMatchObject({
        code: 'TOOL_KILLED',
      });
      expect(h.lookups).toEqual([]);
      expect(h.audits).toEqual([]);
    });

    it('aborts mid-scan: no later host is probed and nothing more is written', async () => {
      const controller = new AbortController();
      const h = harness(labTargets, { signal: controller.signal });
      h.hook.naabu = () => {
        controller.abort();
      };
      await expect(h.run({ hosts: ['www.lab.example', 'api.lab.example'] })).rejects.toMatchObject({
        code: 'TOOL_KILLED',
      });
      expect(h.scans).toHaveLength(1);
      expect(h.writes).toHaveLength(1); // only the host batch
    });

    it('maps an unexpected executor error to a fixed TOOL_BACKEND_UNAVAILABLE and audits it', async () => {
      const h = harness(labTargets, {
        executor: { run: () => Promise.reject(new Error('secret path /root/x')) },
      });
      await expect(h.run({ hosts: ['www.lab.example'] })).rejects.toMatchObject({
        code: 'TOOL_BACKEND_UNAVAILABLE',
        message: 'dnsx failed',
      });
      expect(h.audits).toMatchObject([
        { tool: 'dnsx', outcome: 'error', code: 'TOOL_BACKEND_UNAVAILABLE' },
      ]);
    });

    it('audits every executed batch with the tool, target and port count', async () => {
      const h = harness(labTargets);
      await h.run({ hosts: ['www.lab.example', 'api.lab.example'] });
      expect(h.audits.map((a) => a.inputSummary)).toEqual([
        'dnsx resolve 2 host(s)',
        `naabu connect www.lab.example (${WEB_IP}) 4 port(s)`,
        `naabu connect api.lab.example (${API_IP}) 4 port(s)`,
      ]);
    });

    it('fails closed when a batch cannot be audited: no further probe runs', async () => {
      const h = harness(labTargets, {
        audit: () => Promise.reject(new ToolError('TOOL_BACKEND_UNAVAILABLE', 'down')),
      });
      await expect(h.run({ hosts: ['www.lab.example'] })).rejects.toMatchObject({
        code: 'TOOL_BACKEND_UNAVAILABLE',
      });
      expect(h.lookups).toHaveLength(1);
      expect(h.scans).toEqual([]);
      expect(h.writes).toEqual([]);
    });

    it('lets a rejected surface write (scope violation) fail the call', async () => {
      const h = harness(labTargets);
      const deps: DiscoverDeps = {
        ...h.deps,
        writeSurface: vi.fn().mockRejectedValue(new ToolError('TOOL_SCOPE_DENIED', 'no')),
      };
      await expect(discoverServices(deps, { hosts: ['www.lab.example'] })).rejects.toMatchObject({
        code: 'TOOL_SCOPE_DENIED',
      });
    });
  });

  it('uses the common-port list only after the matcher filtered it', async () => {
    const h = harness(labTargets);
    await h.run({ hosts: ['www.lab.example'] });
    const sent = h.scans[0]?.ports ?? [];
    expect(sent.every((p) => COMMON_PORTS.includes(p))).toBe(true);
    expect(sent).toEqual([80, 443, 3000, 8080]);
  });

  it('passes the resolver, rate and concurrency to the tools, always in CONNECT mode', async () => {
    const seen: (readonly string[])[] = [];
    const h = harness(labTargets);
    const executor: ReconExecutor = {
      run: (tool, args, options) => {
        seen.push(args);
        return h.deps.executor.run(tool, args, options);
      },
    };
    await discoverServices(
      { ...h.deps, executor, resolver: '10.255.0.2' },
      { hosts: ['www.lab.example'] },
    );
    expect(seen[0]).toEqual(expect.arrayContaining(['-r', '10.255.0.2', '-rl', '20', '-t', '5']));
    expect(seen[1]).toEqual(
      expect.arrayContaining(['-scan-type', 'c', '-Pn', '-rate', '20', '-c', '5', '-host', WEB_IP]),
    );
  });
});

describe('discoverServicesInputSchema', () => {
  it('accepts names, IPs and bracketed IPv6, and rejects junk, extra keys and bad ports', () => {
    const ok = (value: unknown) => discoverServicesInputSchema.safeParse(value).success;
    expect(ok({ hosts: ['a.example', '203.0.113.7', '[2001:db8::1]'], ports: [80] })).toBe(true);
    expect(ok({ hosts: [] })).toBe(false);
    expect(ok({ hosts: ['bad host'] })).toBe(false);
    expect(ok({ hosts: ['http://a.example/'] })).toBe(false);
    expect(ok({ hosts: ['a.example'], ports: [0] })).toBe(false);
    expect(ok({ hosts: ['a.example'], ports: [65_536] })).toBe(false);
    expect(ok({ hosts: ['a.example'], scope: 'everything' })).toBe(false);
    expect(ok({ hosts: Array.from({ length: 257 }, () => 'a.example') })).toBe(false);
  });
});
