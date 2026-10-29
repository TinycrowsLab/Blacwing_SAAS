import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canAccessEdgeSchema,
  endpointNodeSchema,
  exposesEdgeSchema,
  hasParamEdgeSchema,
  hostNodeSchema,
  naturalKey,
  parameterNodeSchema,
  provenanceSchema,
  resolvesToEdgeSchema,
  roleNodeSchema,
  runsEdgeSchema,
  SURFACE_BANNER_MAX,
  SURFACE_CONTRACT_VERSION,
  SURFACE_EDGE_KINDS,
  SURFACE_NODE_KINDS,
  serviceNodeSchema,
  servesEdgeSchema,
  surfaceEdgeSchema,
  surfaceNodeSchema,
  technologyNodeSchema,
  templatise,
  assetNodeSchema,
} from './index.js';

const TENANT = '018f0000-0000-7000-8000-00000000000a';
const OTHER_TENANT = '018f0000-0000-7000-8000-00000000000b';
const ASSET = '018f0000-0000-7000-8000-0000000000a1';
const RUN = '018f0000-0000-7000-8000-0000000000c1';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

const provenance = {
  runId: RUN,
  confidence: 0.8,
  firstSeenAt: T0,
  lastSeenAt: T1,
};

const host = {
  kind: 'host',
  tenantId: TENANT,
  provenance,
  hostname: 'app.example.com',
  inScope: true,
} as const;

const service = {
  kind: 'service',
  tenantId: TENANT,
  provenance,
  hostname: 'app.example.com',
  port: 443,
  protocol: 'tcp',
} as const;

const technology = {
  kind: 'technology',
  tenantId: TENANT,
  provenance,
  name: 'nginx',
  version: '1.25.3',
  categories: ['web-server'],
} as const;

const endpoint = {
  kind: 'endpoint',
  tenantId: TENANT,
  provenance,
  assetId: ASSET,
  method: 'GET',
  pathTemplate: '/users/{id}',
  contentTypes: ['application/json'],
  authRequired: true,
} as const;

const parameter = {
  kind: 'parameter',
  tenantId: TENANT,
  provenance,
  endpointKey: `endpoint:${TENANT}:${ASSET}:GET:/users/{id}`,
  name: 'id',
  location: 'path',
  dataType: 'integer',
} as const;

const role = {
  kind: 'role',
  tenantId: TENANT,
  provenance,
  assetId: ASSET,
  roleName: 'viewer',
} as const;

function withProvenance(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...provenance, ...overrides };
}

describe('contract constants', () => {
  it('exports a semver contract version', () => {
    expect(SURFACE_CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SURFACE_CONTRACT_VERSION).toBe('1.0.0');
  });

  it('lists the seven node kinds and six edge kinds of the epic scope', () => {
    expect(SURFACE_NODE_KINDS).toEqual([
      'asset',
      'host',
      'service',
      'technology',
      'endpoint',
      'parameter',
      'role',
    ]);
    expect(SURFACE_EDGE_KINDS).toEqual([
      'RESOLVES_TO',
      'EXPOSES',
      'RUNS',
      'SERVES',
      'HAS_PARAM',
      'CAN_ACCESS',
    ]);
  });

  it('keeps the field set of every node kind visible for review', () => {
    const fields = Object.fromEntries(
      surfaceNodeSchema.options.map((option) => [
        option.shape.kind.value,
        Object.keys(option.shape).sort(),
      ]),
    );
    expect(fields).toEqual({
      asset: ['assetId', 'kind', 'provenance', 'tenantId', 'type'],
      host: ['hostname', 'inScope', 'ip', 'kind', 'provenance', 'tenantId'],
      service: [
        'banner',
        'hostname',
        'kind',
        'port',
        'protocol',
        'provenance',
        'tenantId',
        'transport',
      ],
      technology: ['categories', 'cpe', 'kind', 'name', 'provenance', 'tenantId', 'version'],
      endpoint: [
        'assetId',
        'authRequired',
        'baseUrl',
        'contentTypes',
        'kind',
        'method',
        'pathTemplate',
        'provenance',
        'tenantId',
      ],
      parameter: ['dataType', 'endpointKey', 'kind', 'location', 'name', 'provenance', 'tenantId'],
      role: ['assetId', 'kind', 'provenance', 'roleName', 'tenantId'],
    });
  });
});

describe('provenance', () => {
  it('accepts a complete record and a minimal one', () => {
    expect(provenanceSchema.safeParse(provenance).success).toBe(true);
    expect(
      provenanceSchema.safeParse({
        ...provenance,
        agentSessionId: 'sess-1',
        persona: 'recon',
        tool: 'nmap',
        sourceEvidenceId: 'ev-1',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['confidence above 1', { confidence: 1.01 }],
    ['negative confidence', { confidence: -0.01 }],
    ['NaN confidence', { confidence: Number.NaN }],
    ['infinite confidence', { confidence: Number.POSITIVE_INFINITY }],
    ['lastSeenAt before firstSeenAt', { firstSeenAt: T1, lastSeenAt: T0 }],
    ['non-UTC timestamp', { firstSeenAt: '2026-01-01T00:00:00+02:00' }],
    ['runId that is not a UUIDv7', { runId: '00000000-0000-4000-8000-000000000001' }],
    ['empty persona', { persona: '' }],
    ['unknown field', { extra: true }],
    ['null optional field', { tool: null }],
  ])('rejects %s', (_name, overrides) => {
    expect(provenanceSchema.safeParse(withProvenance(overrides)).success).toBe(false);
  });

  it('accepts equal first and last seen instants', () => {
    expect(provenanceSchema.safeParse({ ...provenance, lastSeenAt: T0 }).success).toBe(true);
  });
});

describe('hostnames', () => {
  it.each([
    ['café.example', 'xn--caf-dma.example'],
    ['xn--caf-dma.example', 'xn--caf-dma.example'],
    ['WWW.Example.COM', 'www.example.com'],
    ['example.com.', 'example.com'],
  ])('normalises %s to %s', (raw, expected) => {
    const parsed = hostNodeSchema.parse({ ...host, hostname: raw });
    expect(parsed.hostname).toBe(expected);
  });

  it.each([
    ['wildcard', '*.example.com'],
    ['IP literal', '10.0.0.1'],
    ['empty', ''],
    ['empty label', 'a..example.com'],
    ['space', 'exa mple.com'],
    ['URL', 'https://example.com'],
    ['port suffix', 'example.com:443'],
    ['overlong label', `${'a'.repeat(64)}.example.com`],
    [
      'overlong name',
      `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
    ],
  ])('rejects a %s hostname', (_name, hostname) => {
    expect(hostNodeSchema.safeParse({ ...host, hostname }).success).toBe(false);
  });

  it('makes unicode and punycode spellings of one name the same natural key', () => {
    const unicode = hostNodeSchema.parse({ ...host, hostname: 'café.example' });
    const punycode = hostNodeSchema.parse({ ...host, hostname: 'xn--caf-dma.example' });
    expect(naturalKey(unicode)).toBe(naturalKey(punycode));
  });
});

describe('host nodes', () => {
  it('requires the in-scope flag and accepts an optional canonical IP', () => {
    expect(hostNodeSchema.safeParse({ ...host, ip: '10.0.0.1' }).success).toBe(true);
    expect(hostNodeSchema.parse({ ...host, ip: '::ffff:10.0.0.1' }).ip).toBe('10.0.0.1');
    expect(hostNodeSchema.safeParse({ ...host, inScope: undefined }).success).toBe(false);
  });

  it('rejects a malformed IP and a null IP (absent means unknown, not null)', () => {
    expect(hostNodeSchema.safeParse({ ...host, ip: 'not-an-ip' }).success).toBe(false);
    expect(hostNodeSchema.safeParse({ ...host, ip: null }).success).toBe(false);
  });

  it('rejects a tenant id that is not a UUIDv7', () => {
    expect(hostNodeSchema.safeParse({ ...host, tenantId: 'tenant-a' }).success).toBe(false);
  });
});

describe('service nodes', () => {
  it.each([0, 65_536, -1, 1.5])('rejects port %s', (port) => {
    expect(serviceNodeSchema.safeParse({ ...service, port }).success).toBe(false);
  });

  it('accepts the port bounds', () => {
    expect(serviceNodeSchema.safeParse({ ...service, port: 1 }).success).toBe(true);
    expect(serviceNodeSchema.safeParse({ ...service, port: 65_535 }).success).toBe(true);
  });

  it('rejects an unknown protocol', () => {
    expect(serviceNodeSchema.safeParse({ ...service, protocol: 'icmp' }).success).toBe(false);
  });

  it('keeps a banner at the cap unchanged', () => {
    const banner = 'a'.repeat(SURFACE_BANNER_MAX);
    expect(serviceNodeSchema.parse({ ...service, banner }).banner).toBe(banner);
  });

  it('truncates an oversized banner with an ellipsis instead of rejecting it', () => {
    const banner = serviceNodeSchema.parse({ ...service, banner: 'x'.repeat(5000) }).banner;
    expect(banner).toHaveLength(SURFACE_BANNER_MAX);
    expect(banner?.endsWith('…')).toBe(true);
  });

  it('never leaves a lone surrogate when the cut falls inside a pair', () => {
    const raw = `${'a'.repeat(SURFACE_BANNER_MAX - 2)}😀b`;
    const banner = serviceNodeSchema.parse({ ...service, banner: raw }).banner ?? '';
    expect(banner.endsWith('…')).toBe(true);
    expect(banner.length).toBeLessThanOrEqual(SURFACE_BANNER_MAX);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(banner)).toBe(false);
  });
});

describe('technology nodes', () => {
  it('accepts a technology with optional version and CPE', () => {
    expect(
      technologyNodeSchema.safeParse({
        ...technology,
        cpe: 'cpe:2.3:a:nginx:nginx:1.25.3:*:*:*:*:*:*:*',
      }).success,
    ).toBe(true);
    expect(
      technologyNodeSchema.safeParse({ ...technology, version: undefined, categories: [] }).success,
    ).toBe(true);
  });

  it('rejects a CPE that is not CPE 2.3', () => {
    expect(technologyNodeSchema.safeParse({ ...technology, cpe: 'nginx 1.25' }).success).toBe(
      false,
    );
  });

  it('requires a categories array', () => {
    expect(technologyNodeSchema.safeParse({ ...technology, categories: undefined }).success).toBe(
      false,
    );
  });

  it('rejects a name with surrounding whitespace or an empty version', () => {
    expect(technologyNodeSchema.safeParse({ ...technology, name: ' nginx' }).success).toBe(false);
    expect(technologyNodeSchema.safeParse({ ...technology, version: '' }).success).toBe(false);
  });
});

describe('endpoint nodes', () => {
  it('upper-cases the method and accepts a template path', () => {
    expect(endpointNodeSchema.parse({ ...endpoint, method: 'get' }).method).toBe('GET');
  });

  it.each([
    ['an unknown method', { method: 'FETCH' }],
    ['a relative path', { pathTemplate: 'users/{id}' }],
    ['a query string', { pathTemplate: '/users?id=1' }],
    ['a fragment', { pathTemplate: '/users#x' }],
    ['a dot-dot segment in a template', { pathTemplate: '/a/../../b' }],
    ['a base URL with a non-http scheme', { baseUrl: 'ftp://api.example.com' }],
    ['a base URL with credentials', { baseUrl: 'https://user:secret@api.example.com/v1' }],
    ['a malformed content type', { contentTypes: ['not a type'] }],
    ['a missing authRequired flag', { authRequired: undefined }],
  ])('rejects %s', (_name, overrides) => {
    expect(endpointNodeSchema.safeParse({ ...endpoint, ...overrides }).success).toBe(false);
  });

  it('lower-cases content types and accepts an https base URL', () => {
    const parsed = endpointNodeSchema.parse({
      ...endpoint,
      contentTypes: ['Application/JSON'],
      baseUrl: 'https://api.example.com/v1',
    });
    expect(parsed.contentTypes).toEqual(['application/json']);
    expect(parsed.baseUrl).toBe('https://api.example.com/v1');
  });
});

describe('parameter nodes', () => {
  it('stores name, location and type only', () => {
    expect(parameterNodeSchema.safeParse(parameter).success).toBe(true);
  });

  it('rejects an example value (captured values are never stored, §8.7)', () => {
    expect(parameterNodeSchema.safeParse({ ...parameter, example: 'hunter2' }).success).toBe(false);
  });

  it.each(['formdata', 'Query', ''])('rejects the location %s', (location) => {
    expect(parameterNodeSchema.safeParse({ ...parameter, location }).success).toBe(false);
  });

  it('rejects an endpoint key that belongs to another tenant', () => {
    const endpointKey = `endpoint:${OTHER_TENANT}:${ASSET}:GET:/users/{id}`;
    expect(parameterNodeSchema.safeParse({ ...parameter, endpointKey }).success).toBe(false);
  });

  it('rejects a name with surrounding whitespace', () => {
    expect(parameterNodeSchema.safeParse({ ...parameter, name: ' id' }).success).toBe(false);
  });
});

describe('role nodes', () => {
  it('accepts a role and rejects an empty name', () => {
    expect(roleNodeSchema.safeParse(role).success).toBe(true);
    expect(roleNodeSchema.safeParse({ ...role, roleName: '' }).success).toBe(false);
  });
});

describe('asset nodes', () => {
  it('reuses the asset type vocabulary', () => {
    expect(
      assetNodeSchema.safeParse({
        kind: 'asset',
        tenantId: TENANT,
        provenance,
        assetId: ASSET,
        type: 'web_app',
      }).success,
    ).toBe(true);
    expect(
      assetNodeSchema.safeParse({
        kind: 'asset',
        tenantId: TENANT,
        provenance,
        assetId: ASSET,
        type: 'mainframe',
      }).success,
    ).toBe(false);
  });
});

describe('naturalKey', () => {
  const cases: [string, ReturnType<typeof surfaceNodeSchema.parse>, string][] = [
    [
      'asset',
      surfaceNodeSchema.parse({
        kind: 'asset',
        tenantId: TENANT,
        provenance,
        assetId: ASSET,
        type: 'api',
      }),
      `asset:${TENANT}:${ASSET}`,
    ],
    ['host', surfaceNodeSchema.parse(host), `host:${TENANT}:app.example.com`],
    ['service', surfaceNodeSchema.parse(service), `service:${TENANT}:app.example.com:443:tcp`],
    ['technology', surfaceNodeSchema.parse(technology), `technology:${TENANT}:nginx:1.25.3`],
    [
      'technology without version',
      surfaceNodeSchema.parse({ ...technology, version: undefined }),
      `technology:${TENANT}:nginx:`,
    ],
    ['endpoint', surfaceNodeSchema.parse(endpoint), `endpoint:${TENANT}:${ASSET}:GET:/users/{id}`],
    [
      'parameter',
      surfaceNodeSchema.parse(parameter),
      `parameter:${TENANT}:${encodeURIComponent(parameter.endpointKey)}:path:id`,
    ],
    ['role', surfaceNodeSchema.parse(role), `role:${TENANT}:${ASSET}:viewer`],
  ];

  it.each(cases)('builds the %s key from the GRAPH-002 columns', (_name, node, expected) => {
    expect(naturalKey(node)).toBe(expected);
  });

  it('gives a parameter the key of the endpoint it references', () => {
    const endpointNode = surfaceNodeSchema.parse(endpoint);
    expect(parameterNodeSchema.parse(parameter).endpointKey).toBe(naturalKey(endpointNode));
  });

  it('keeps nodes that differ only in a colon-bearing component apart', () => {
    const a = surfaceNodeSchema.parse({ ...technology, name: 'a:b', version: 'c' });
    const b = surfaceNodeSchema.parse({ ...technology, name: 'a', version: 'b:c' });
    expect(naturalKey(a)).not.toBe(naturalKey(b));
  });

  it('keeps tenants apart', () => {
    const one = surfaceNodeSchema.parse(host);
    const two = surfaceNodeSchema.parse({ ...host, tenantId: OTHER_TENANT });
    expect(naturalKey(one)).not.toBe(naturalKey(two));
  });

  it('distinguishes endpoints by method and by path', () => {
    const get = surfaceNodeSchema.parse(endpoint);
    const post = surfaceNodeSchema.parse({ ...endpoint, method: 'POST' });
    const other = surfaceNodeSchema.parse({ ...endpoint, pathTemplate: '/users/{id}/roles' });
    expect(naturalKey(get)).not.toBe(naturalKey(post));
    expect(naturalKey(get)).not.toBe(naturalKey(other));
  });
});

describe('edges', () => {
  const edgeBase = { tenantId: TENANT, provenance };
  const assetKey = `asset:${TENANT}:${ASSET}`;
  const hostKey = `host:${TENANT}:app.example.com`;
  const serviceKey = `service:${TENANT}:app.example.com:443:tcp`;
  const techKey = `technology:${TENANT}:nginx:1.25.3`;
  const endpointKey = `endpoint:${TENANT}:${ASSET}:GET:/users/{id}`;
  const paramKey = `parameter:${TENANT}:${encodeURIComponent(endpointKey)}:path:id`;
  const roleKey = `role:${TENANT}:${ASSET}:viewer`;

  it('accepts each edge kind between its allowed node kinds', () => {
    const valid = [
      { ...edgeBase, kind: 'RESOLVES_TO', fromKey: assetKey, toKey: hostKey },
      { ...edgeBase, kind: 'EXPOSES', fromKey: hostKey, toKey: serviceKey },
      { ...edgeBase, kind: 'RUNS', fromKey: serviceKey, toKey: techKey },
      { ...edgeBase, kind: 'SERVES', fromKey: serviceKey, toKey: endpointKey },
      { ...edgeBase, kind: 'SERVES', fromKey: assetKey, toKey: endpointKey },
      { ...edgeBase, kind: 'HAS_PARAM', fromKey: endpointKey, toKey: paramKey },
      { ...edgeBase, kind: 'CAN_ACCESS', fromKey: roleKey, toKey: endpointKey, expected: 'deny' },
    ];
    for (const edge of valid) {
      expect(surfaceEdgeSchema.safeParse(edge).success, edge.kind).toBe(true);
    }
  });

  it('rejects an edge that joins the wrong node kinds', () => {
    expect(
      resolvesToEdgeSchema.safeParse({
        ...edgeBase,
        kind: 'RESOLVES_TO',
        fromKey: hostKey,
        toKey: assetKey,
      }).success,
    ).toBe(false);
    expect(
      exposesEdgeSchema.safeParse({
        ...edgeBase,
        kind: 'EXPOSES',
        fromKey: hostKey,
        toKey: techKey,
      }).success,
    ).toBe(false);
    expect(
      runsEdgeSchema.safeParse({
        ...edgeBase,
        kind: 'RUNS',
        fromKey: serviceKey,
        toKey: serviceKey,
      }).success,
    ).toBe(false);
    expect(
      servesEdgeSchema.safeParse({
        ...edgeBase,
        kind: 'SERVES',
        fromKey: hostKey,
        toKey: endpointKey,
      }).success,
    ).toBe(false);
    expect(
      hasParamEdgeSchema.safeParse({
        ...edgeBase,
        kind: 'HAS_PARAM',
        fromKey: endpointKey,
        toKey: endpointKey,
      }).success,
    ).toBe(false);
  });

  it('rejects an edge that joins nodes of two tenants (§8.6)', () => {
    const foreignHost = `host:${OTHER_TENANT}:app.example.com`;
    expect(
      resolvesToEdgeSchema.safeParse({
        ...edgeBase,
        kind: 'RESOLVES_TO',
        fromKey: assetKey,
        toKey: foreignHost,
      }).success,
    ).toBe(false);
  });

  it('requires an expected allow or deny on CAN_ACCESS', () => {
    expect(
      canAccessEdgeSchema.safeParse({
        ...edgeBase,
        kind: 'CAN_ACCESS',
        fromKey: roleKey,
        toKey: endpointKey,
      }).success,
    ).toBe(false);
    expect(
      canAccessEdgeSchema.safeParse({
        ...edgeBase,
        kind: 'CAN_ACCESS',
        fromKey: roleKey,
        toKey: endpointKey,
        expected: 'maybe',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown edge kind and extra fields', () => {
    expect(
      surfaceEdgeSchema.safeParse({ ...edgeBase, kind: 'OWNS', fromKey: assetKey, toKey: hostKey })
        .success,
    ).toBe(false);
    expect(
      resolvesToEdgeSchema.safeParse({
        ...edgeBase,
        kind: 'RESOLVES_TO',
        fromKey: assetKey,
        toKey: hostKey,
        weight: 1,
      }).success,
    ).toBe(false);
  });
});

describe('templatise', () => {
  it.each([
    ['/users/42', '/users/{id}'],
    ['/users/42/orders/3f9c2a1b4d5e6f70?expand=1', '/users/{id}/orders/{id}'],
    ['/files/018f0000-0000-7000-8000-0000000000a1/meta', '/files/{id}/meta'],
    ['/v1/users', '/v1/users'],
    ['/users/{id}', '/users/{id}'],
    ['/', '/'],
    ['/a//b/./c/', '/a/b/c'],
  ])('turns %s into %s', (raw, expected) => {
    expect(templatise(raw)).toBe(expected);
  });

  it.each(['users/1', '/a/%zz', ''])('returns null for the invalid path %s', (raw) => {
    expect(templatise(raw)).toBeNull();
  });
});

describe('round trip (property)', () => {
  const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
  // A numeric last label would read as an IP literal, so every generated name ends in a word.
  const hostname = fc
    .array(label, { minLength: 1, maxLength: 3 })
    .map((labels) => [...labels, 'example'].join('.'));
  const serviceArb = fc.record({
    hostname,
    port: fc.integer({ min: 1, max: 65_535 }),
    protocol: fc.constantFrom('tcp', 'udp'),
  });

  it('parses, keys and re-parses service nodes to the same value and key', () => {
    fc.assert(
      fc.property(serviceArb, (input) => {
        const first = serviceNodeSchema.parse({ ...service, ...input });
        const again = surfaceNodeSchema.parse(structuredClone(first));
        expect(naturalKey(again)).toBe(naturalKey(first));
        expect(again).toEqual(first);
      }),
    );
  });

  it('keeps a truncated banner within the cap for any input length', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 3000 }), (banner) => {
        const parsed = serviceNodeSchema.parse({ ...service, banner });
        expect((parsed.banner ?? '').length).toBeLessThanOrEqual(SURFACE_BANNER_MAX);
      }),
    );
  });
});
