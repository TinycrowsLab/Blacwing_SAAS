import { describe, expect, it, vi } from 'vitest';

import { parseScopeRules } from '@blackwing/contracts';
import { ScopeViolationError, TenantContextMissingError, ValidationError } from '@blackwing/errors';

import { InvalidSurfaceInputError, SurfaceBatchTooLargeError } from './errors.js';
import {
  endpointKey,
  hostKey,
  parameterKey,
  roleKey,
  serviceKey,
  technologyKey,
} from './fingerprint.js';
import { normaliseUrlTemplate } from './normalise.js';
import {
  SURFACE_WRITE_METRIC,
  type SurfaceWriteContext,
  surfaceNodeKey,
  surfaceWriteRequestSchema,
  writeSurface,
  WRITE_SURFACE_TOOL,
} from './write.js';

const A = '0190a000-0000-7000-8000-000000000001';
const TENANT = '0190a000-0000-7000-8000-0000000000aa';
const RUN = '0190a000-0000-7000-8000-0000000000b1';
const SESSION = '0190a000-0000-7000-8000-0000000000b2';
const UUID4 = '123e4567-e89b-12d3-a456-426614174000';

describe('normaliseUrlTemplate', () => {
  it.each([
    ['trailing slash', 'https://a.example/x/y/', 'https://a.example/x/y'],
    ['root', 'https://a.example', 'https://a.example/'],
    ['default https port', 'https://A.example:443/x', 'https://a.example/x'],
    ['default http port', 'http://a.example:80/x', 'http://a.example/x'],
    ['non-default port kept', 'https://a.example:8443/x', 'https://a.example:8443/x'],
    ['IDN to punycode', 'https://bücher.example/x', 'https://xn--bcher-kva.example/x'],
    ['percent unreserved decoded', 'https://a.example/%61b/%7Euser', 'https://a.example/ab/~user'],
    ['percent hex upper-cased', 'https://a.example/a%2fb', 'https://a.example/a%2Fb'],
    [
      'numeric tokenised',
      'https://a.example/users/42/posts/7',
      'https://a.example/users/{id}/posts/{id}',
    ],
    ['encoded numeric tokenised', 'https://a.example/users/%34%32', 'https://a.example/users/{id}'],
    [
      'uuid tokenised',
      `https://a.example/o/${UUID4.toUpperCase()}/x`,
      'https://a.example/o/{id}/x',
    ],
    ['query values stripped, sorted', 'https://a.example/s?b=2&a=1&b=3', 'https://a.example/s?a&b'],
    ['fragment and userinfo dropped', 'https://u:p@a.example/x#frag', 'https://a.example/x'],
    ['dot segments', 'https://a.example/a/../b/./c', 'https://a.example/b/c'],
    ['ipv6', 'http://[::1]:8080/x', 'http://[::1]:8080/x'],
  ])('%s', (_n, input, expected) => {
    expect(normaliseUrlTemplate(input)).toBe(expected);
  });

  it('collapses equivalent variants to one template', () => {
    expect(normaliseUrlTemplate('HTTPS://Example.COM:443/a/1/?x=1')).toBe(
      normaliseUrlTemplate('https://example.com/a/99?x=zzz'),
    );
  });

  it.each([
    null,
    undefined,
    42,
    '',
    ' https://a.example',
    'not a url',
    '/relative',
    'ftp://a.example/',
    'data:text/plain,x',
    'https://',
    `https://a.example/${'a'.repeat(9000)}`,
  ])('rejects %j', (input) => {
    expect(() => normaliseUrlTemplate(input)).toThrow(InvalidSurfaceInputError);
  });
});

describe('fingerprint keys', () => {
  const hex = /^[0-9a-f]{64}$/;

  it('host key is stable across case, IDN, trailing dot and IP form', () => {
    expect(hostKey(A, 'Example.COM.')).toBe(hostKey(A, 'example.com'));
    expect(hostKey(A, 'BÜCHER.example')).toBe(hostKey(A, 'xn--bcher-kva.example'));
    expect(hostKey(A, '2001:DB8:0:0:0:0:0:1')).toBe(hostKey(A, '[2001:db8::1]'));
    expect(hostKey(A, 'example.com')).toMatch(hex);
  });

  it('keys differ by asset (tenant-asset isolation of identity)', () => {
    expect(hostKey(A, 'a.example')).not.toBe(hostKey(UUID4, 'a.example'));
  });

  it('service, technology, role, parameter keys are stable and distinct', () => {
    const h = hostKey(A, 'a.example');
    expect(serviceKey(h, 443, 'TCP')).toBe(serviceKey(h, 443, 'tcp'));
    expect(serviceKey(h, 443, 'tcp')).not.toBe(serviceKey(h, 443, 'udp'));
    expect(technologyKey(h, 'Nginx', '1.25')).toBe(technologyKey(h, 'nginx', '1.25'));
    expect(technologyKey(h, 'nginx')).not.toBe(technologyKey(h, 'nginx', '1.25'));
    expect(roleKey(A, ' Admin ')).toBe(roleKey(A, 'admin'));
    const e = endpointKey(A, 'get', 'https://a.example/u/1');
    expect(parameterKey(e, 'QUERY', 'id')).toBe(parameterKey(e, 'query', 'id'));
    expect(parameterKey(e, 'query', 'id')).not.toBe(parameterKey(e, 'query', 'ID'));
    expect(parameterKey(e, 'query', 'id')).not.toBe(parameterKey(e, 'body', 'id'));
  });

  it('one logical endpoint from two sources yields one key; paths stay case-sensitive', () => {
    expect(endpointKey(A, 'get', 'HTTPS://A.example:443/u/1/?q=1')).toBe(
      endpointKey(A, 'GET', 'https://a.example/u/2?q=2'),
    );
    expect(endpointKey(A, 'GET', 'https://a.example/Admin')).not.toBe(
      endpointKey(A, 'GET', 'https://a.example/admin'),
    );
    expect(endpointKey(A, 'GET', 'https://a.example/x')).not.toBe(
      endpointKey(A, 'POST', 'https://a.example/x'),
    );
  });

  it('is not fooled by the separator character', () => {
    expect(roleKey('a', 'b|c')).not.toBe(roleKey('a|b', 'c'));
  });

  it('rejects malformed input without producing a key', () => {
    expect(() => hostKey(A, 'bad host')).toThrow(InvalidSurfaceInputError);
    expect(() => hostKey('', 'a.example')).toThrow(InvalidSurfaceInputError);
    expect(() => serviceKey('x', 0, 'tcp')).toThrow(InvalidSurfaceInputError);
    expect(() => serviceKey('x', 80, 'sctp')).toThrow(InvalidSurfaceInputError);
    expect(() => endpointKey(A, 'FETCH', 'https://a.example/')).toThrow(InvalidSurfaceInputError);
    expect(() => endpointKey(A, 'GET', 'nope')).toThrow(InvalidSurfaceInputError);
    expect(() => parameterKey('x', 'nowhere', 'a')).toThrow(InvalidSurfaceInputError);
    expect(() => parameterKey('x', 'query', ' ')).toThrow(InvalidSurfaceInputError);
  });
});

const provenance = {
  runId: RUN,
  sessionId: SESSION,
  persona: 'recon-web',
  tool: 'httpx',
  toolVersion: '1.6.0',
  confidence: 0.9,
  observedAt: '2026-01-01T00:00:00.000Z',
};
const scope = parseScopeRules({
  rules: [
    { effect: 'include', host: '*.a.example' },
    { effect: 'include', cidr: '10.0.0.0/24' },
  ],
});

function ctx(over: Partial<SurfaceWriteContext> = {}): {
  c: SurfaceWriteContext;
  callTool: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn().mockResolvedValue({ ok: true });
  const audit = vi.fn();
  return { c: { tenantId: TENANT, scope, callTool, audit, ...over }, callTool, audit };
}

const hostNode = { type: 'host', assetId: A, address: 'www.a.example' } as const;

describe('SurfaceWriteRequest schema', () => {
  it('rejects unknown keys at every level', () => {
    const base = { nodes: [hostNode], edges: [], provenance };
    expect(surfaceWriteRequestSchema.safeParse(base).success).toBe(true);
    expect(surfaceWriteRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(
      surfaceWriteRequestSchema.safeParse({ ...base, nodes: [{ ...hostNode, password: 'x' }] })
        .success,
    ).toBe(false);
    expect(
      surfaceWriteRequestSchema.safeParse({ ...base, provenance: { ...provenance, x: 1 } }).success,
    ).toBe(false);
  });

  it('accepts a pinned IP on a host node without changing its key', () => {
    const parse = (pinnedIp: string) =>
      surfaceWriteRequestSchema.safeParse({
        nodes: [{ ...hostNode, pinnedIp }],
        edges: [],
        provenance,
      }).success;
    expect(parse('203.0.113.7')).toBe(true);
    expect(parse('2001:db8::1')).toBe(true);
    expect(parse('not-an-ip')).toBe(false);
    expect(surfaceNodeKey({ ...hostNode, pinnedIp: '203.0.113.7' })).toBe(surfaceNodeKey(hostNode));
  });

  it('bounds confidence and requires an ISO instant', () => {
    const p = (o: object) =>
      surfaceWriteRequestSchema.safeParse({
        nodes: [],
        edges: [],
        provenance: { ...provenance, ...o },
      }).success;
    expect(p({ confidence: 1.1 })).toBe(false);
    expect(p({ confidence: -0.1 })).toBe(false);
    expect(p({ observedAt: 'yesterday' })).toBe(false);
  });
});

describe('writeSurface', () => {
  it('writes keyed nodes through the MCP tool with tenant context, metrics and log', async () => {
    const increment = vi.fn();
    const log = vi.fn();
    const { c, callTool } = ctx({ increment, log });
    const ep = {
      type: 'endpoint',
      assetId: A,
      method: 'get',
      url: 'https://www.a.example/u/1?x=1',
    } as const;
    const res = await writeSurface(c, { nodes: [hostNode, ep], edges: [], provenance });
    expect(res).toEqual({ nodeCount: 2, edgeCount: 0 });
    const [tool, arg] = callTool.mock.calls[0] as [
      string,
      { tenantId: string; request: { nodes: { key: string }[] } },
    ];
    expect(tool).toBe(WRITE_SURFACE_TOOL);
    expect(arg.tenantId).toBe(TENANT);
    expect(arg.request.nodes.map((n) => n.key)).toEqual([
      surfaceNodeKey(hostNode),
      surfaceNodeKey(ep),
    ]);
    expect(increment).toHaveBeenCalledWith(
      SURFACE_WRITE_METRIC,
      { persona: 'recon-web', nodeType: 'host' },
      1,
    );
    expect(increment).toHaveBeenCalledWith(
      SURFACE_WRITE_METRIC,
      { persona: 'recon-web', nodeType: 'endpoint' },
      1,
    );
    expect(log).toHaveBeenCalledWith({
      runId: RUN,
      sessionId: SESSION,
      persona: 'recon-web',
      nodeCount: 2,
      edgeCount: 0,
    });
  });

  it('two sessions writing the same entity send identical keys', async () => {
    const a = ctx();
    const b = ctx();
    await writeSurface(a.c, {
      nodes: [{ ...hostNode, address: 'WWW.A.EXAMPLE.' }],
      edges: [],
      provenance,
    });
    await writeSurface(b.c, {
      nodes: [hostNode],
      edges: [],
      provenance: { ...provenance, sessionId: RUN },
    });
    const key = (m: ReturnType<typeof vi.fn>) =>
      (m.mock.calls[0] as [string, { request: { nodes: { key: string }[] } }])[1].request.nodes[0]
        ?.key;
    expect(key(a.callTool)).toBe(key(b.callTool));
  });

  it('checks host and technology nodes at address level when the scope restricts ports', async () => {
    const restricted = parseScopeRules({
      rules: [
        { effect: 'include', host: '*.a.example', ports: [80, 443] },
        { effect: 'exclude', host: 'db.a.example', ports: [3306] },
        { effect: 'exclude', host: 'secret.a.example' },
      ],
    });
    const tech = { type: 'technology', assetId: A, address: 'www.a.example', product: 'nginx' };
    const ok = ctx({ scope: restricted });
    await writeSurface(ok.c, { nodes: [hostNode, tech], edges: [], provenance });
    expect(ok.callTool).toHaveBeenCalledTimes(1);
    // A port-scoped exclude does not exclude the host itself; a whole-host exclude does.
    await writeSurface(ok.c, {
      nodes: [{ ...hostNode, address: 'db.a.example' }],
      edges: [],
      provenance,
    });
    const denied = ctx({ scope: restricted });
    await expect(
      writeSurface(denied.c, {
        nodes: [{ ...hostNode, address: 'secret.a.example' }],
        edges: [],
        provenance,
      }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(
      writeSurface(denied.c, {
        nodes: [{ ...hostNode, address: 'www.other.example' }],
        edges: [],
        provenance,
      }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    // Services keep the full check, port included.
    const service = (port: number) => ({
      type: 'service',
      assetId: A,
      address: 'www.a.example',
      port,
      proto: 'tcp',
    });
    await writeSurface(ok.c, { nodes: [service(443)], edges: [], provenance });
    await expect(
      writeSurface(denied.c, { nodes: [service(22)], edges: [], provenance }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    expect(denied.callTool).not.toHaveBeenCalled();
  });

  it('empty arrays are a no-op success', async () => {
    const { c, callTool } = ctx();
    expect(await writeSurface(c, { nodes: [], edges: [], provenance })).toEqual({
      nodeCount: 0,
      edgeCount: 0,
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('rejects oversized batches before parsing', async () => {
    const { c, callTool } = ctx();
    const nodes = Array.from({ length: 501 }, () => hostNode);
    await expect(writeSurface(c, { nodes, edges: [], provenance })).rejects.toBeInstanceOf(
      SurfaceBatchTooLargeError,
    );
    const edge = { type: 'exposes', from: 'a'.repeat(64), to: 'b'.repeat(64) };
    const edges = Array.from({ length: 1001 }, () => edge);
    await expect(writeSurface(c, { nodes: [], edges, provenance })).rejects.toBeInstanceOf(
      SurfaceBatchTooLargeError,
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it('accepts exactly the cap', async () => {
    const { c, callTool } = ctx();
    const nodes = Array.from({ length: 500 }, () => hostNode);
    const edge = { type: 'exposes', from: 'a'.repeat(64), to: 'b'.repeat(64) };
    const edges = Array.from({ length: 1000 }, () => edge);
    await writeSurface(c, { nodes, edges, provenance });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('fails closed without a valid tenant context', async () => {
    for (const tenantId of ['', 'not-a-uuid']) {
      const { c, callTool } = ctx({ tenantId });
      await expect(
        writeSurface(c, { nodes: [hostNode], edges: [], provenance }),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
      expect(callTool).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed input and bad URLs without a partial write', async () => {
    const { c, callTool } = ctx();
    await expect(
      writeSurface(c, { nodes: [{ type: 'host' }], edges: [], provenance }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(writeSurface(c, null)).rejects.toBeInstanceOf(ValidationError);
    const bad = { type: 'endpoint', assetId: A, method: 'GET', url: 'nope' };
    await expect(
      writeSurface(c, { nodes: [hostNode, bad], edges: [], provenance }),
    ).rejects.toBeInstanceOf(InvalidSurfaceInputError);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('rejects and audits an out-of-scope node, rejecting the whole batch', async () => {
    const { c, callTool, audit } = ctx();
    const evil = {
      type: 'endpoint',
      assetId: A,
      method: 'GET',
      url: 'https://evil.example/x',
    } as const;
    await expect(
      writeSurface(c, { nodes: [hostNode, evil], edges: [], provenance }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    expect(callTool).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'recon.surface_write.denied',
        tenantId: TENANT,
        nodeType: 'endpoint',
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toContain('evil.example/x');
  });

  it('scope covers hosts by name or IP, services by port, technologies; roles need none', async () => {
    const { c, callTool, audit } = ctx();
    const ok = [
      { type: 'host', assetId: A, address: '10.0.0.7' },
      { type: 'service', assetId: A, address: '10.0.0.7', port: 22, proto: 'tcp' },
      { type: 'technology', assetId: A, address: 'x.a.example', product: 'nginx' },
      { type: 'role', assetId: A, roleName: 'admin' },
    ];
    await writeSurface(c, { nodes: ok, edges: [], provenance });
    expect(callTool).toHaveBeenCalledTimes(1);
    for (const node of [
      { type: 'host', assetId: A, address: '10.0.1.7' },
      { type: 'technology', assetId: A, address: 'evil.example', product: 'nginx' },
      { type: 'service', assetId: A, address: '192.168.0.1', port: 80, proto: 'tcp' },
    ]) {
      await expect(
        writeSurface(c, { nodes: [node], edges: [], provenance }),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    }
    expect(audit).toHaveBeenCalledTimes(3);
  });

  it('empty scope rules deny everything', async () => {
    const { c } = ctx({ scope: parseScopeRules({ rules: [] }) });
    await expect(
      writeSurface(c, { nodes: [hostNode], edges: [], provenance }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
  });
});
