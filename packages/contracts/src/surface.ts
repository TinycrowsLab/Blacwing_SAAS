import { z } from 'zod';

import { assetTypeSchema } from './entities/asset.js';
import { LIMITS } from './limits.js';
import { isBefore, isoDateTimeSchema, uuidV7Schema } from './primitives.js';
import { httpMethodSchema, normaliseHost, normaliseIp, normalisePath } from './scope.js';

/**
 * Surface-graph contracts (GRAPH-001, CONTEXT_PACK §3.1 and §3.2 steps 4-5). Recon writes the surface
 * model (Neo4j + Postgres) and the planner reads it. This file is the single source of truth for the
 * node and edge shapes, their natural keys and the contract version.
 *
 * Pure module: no database or graph driver imports, so INGEST and the API can use it directly.
 *
 * Natural keys are `kind:tenantId:...` strings. The tenant prefix is checked on every edge, so an
 * edge can never join nodes from two tenants (§8.6). Free-text components are percent-encoded where
 * they could contain a `:`, so distinct nodes never share a key.
 */

/**
 * Semver of the surface contract. Bump the major on any breaking change to a node, edge or key shape.
 * GRAPH-006 snapshots record it.
 */
export const SURFACE_CONTRACT_VERSION = '1.0.0';

export const SURFACE_NODE_KINDS = [
  'asset',
  'host',
  'service',
  'technology',
  'endpoint',
  'parameter',
  'role',
] as const;
export const surfaceNodeKindSchema = z.enum(SURFACE_NODE_KINDS);
export type SurfaceNodeKind = z.infer<typeof surfaceNodeKindSchema>;

export const SURFACE_EDGE_KINDS = [
  'RESOLVES_TO',
  'EXPOSES',
  'RUNS',
  'SERVES',
  'HAS_PARAM',
  'CAN_ACCESS',
] as const;
export const surfaceEdgeKindSchema = z.enum(SURFACE_EDGE_KINDS);
export type SurfaceEdgeKind = z.infer<typeof surfaceEdgeKindSchema>;

/** Longest banner kept; a longer banner is truncated with an ellipsis, never rejected. */
export const SURFACE_BANNER_MAX = 1024;
/** Longest natural key accepted from an input (endpoint keys and their references included). */
const SURFACE_KEY_MAX = 4096;
const SURFACE_CPE_MAX = 512;
const SURFACE_CATEGORIES_MAX = 32;
const SURFACE_CONTENT_TYPES_MAX = 32;
const SURFACE_CONTENT_TYPE_MAX = 255;
const CPE_PREFIX = 'cpe:2.3:';
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const PARAMETER_LOCATIONS = ['query', 'path', 'header', 'cookie', 'body'] as const;
const PROTOCOLS = ['tcp', 'udp'] as const;
const ACCESS_EXPECTATIONS = ['allow', 'deny'] as const;
/** Path segments that are concrete identifiers, replaced by `{id}` in `templatise`. */
const ID_SEGMENT =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

/** A non-empty, trimmed short string (names, versions, categories). */
function token(max: number): z.ZodString {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace');
}

/** Maps a transform's failure to a schema issue, so the caller gets a validation error. */
function canonical<T>(
  value: string,
  ctx: z.RefinementCtx,
  normalise: (raw: string) => T | null,
  message: string,
): T {
  const result = normalise(value);
  if (result === null) {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  }
  return result;
}

/** Keeps at most `max` characters (counting UTF-16 units), ending in an ellipsis when cut. */
function truncateWithMarker(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max - 1);
  // Never leave a lone high surrogate at the cut point.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// ---------------------------------------------------------------------------------------------
// Shared parts
// ---------------------------------------------------------------------------------------------

/** Where a surface fact came from. `confidence` is the producing tool's or agent's own estimate. */
export const provenanceSchema = z
  .strictObject({
    runId: uuidV7Schema,
    agentSessionId: token(LIMITS.keyMax).optional(),
    persona: token(LIMITS.keyMax).optional(),
    tool: token(LIMITS.keyMax).optional(),
    confidence: z.number().min(0).max(1),
    firstSeenAt: isoDateTimeSchema,
    lastSeenAt: isoDateTimeSchema,
    sourceEvidenceId: token(LIMITS.keyMax).optional(),
  })
  .superRefine((value, ctx) => {
    if (isBefore(value.lastSeenAt, value.firstSeenAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['lastSeenAt'],
        message: 'lastSeenAt must not be before firstSeenAt',
      });
    }
  });
export type Provenance = z.infer<typeof provenanceSchema>;

/**
 * A DNS name in canonical form: lowercase, IDNA (UTS #46) to ASCII, no trailing dot. Unicode and
 * punycode spellings of one name therefore produce one value. An IP literal, a wildcard or a name
 * that is not a valid DNS name is rejected.
 */
const surfaceHostnameSchema = z
  .string()
  .transform((raw, ctx) => canonical(raw, ctx, normaliseHost, 'must be a valid DNS hostname'));

const surfaceIpSchema = z
  .string()
  .max(LIMITS.shortTextMax)
  .transform((raw, ctx) => canonical(raw, ctx, normaliseIp, 'must be an IP address'));

const surfaceBannerSchema = z
  .string()
  .transform((raw) => truncateWithMarker(raw, SURFACE_BANNER_MAX));

/** Templates such as `/users/{id}`: a path with no query or fragment, in canonical form. */
const pathTemplateSchema = z
  .string()
  .min(1)
  .max(LIMITS.urlMax)
  .refine((value) => !/[?#]/.test(value), 'must be a path template without a query or fragment')
  .transform((raw, ctx) => {
    const result = normalisePath(raw, { allowDotDot: false });
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: `invalid path template: ${result.reason}` });
      return z.NEVER;
    }
    return result.path;
  });

const contentTypeSchema = z
  .string()
  .max(SURFACE_CONTENT_TYPE_MAX)
  .transform((raw, ctx) => {
    const value = raw.toLowerCase();
    if (!MEDIA_TYPE.test(value)) {
      ctx.addIssue({ code: 'custom', message: 'must be a media type' });
      return z.NEVER;
    }
    return value;
  });

/**
 * An endpoint's `baseUrl`: an absolute http(s) URL without credentials. Secrets must never be
 * stored in the surface model (§8.7).
 */
const baseUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(LIMITS.urlMax)
  .refine((value) => {
    const url = new URL(value);
    return url.username === '' && url.password === '';
  }, 'must not carry credentials');

const nodeBase = {
  tenantId: uuidV7Schema,
  provenance: provenanceSchema,
} as const;

// ---------------------------------------------------------------------------------------------
// Node schemas
// ---------------------------------------------------------------------------------------------

export const assetNodeSchema = z.strictObject({
  kind: z.literal('asset'),
  ...nodeBase,
  assetId: uuidV7Schema,
  type: assetTypeSchema,
});
export type AssetNode = z.infer<typeof assetNodeSchema>;

export const hostNodeSchema = z.strictObject({
  kind: z.literal('host'),
  ...nodeBase,
  hostname: surfaceHostnameSchema,
  ip: surfaceIpSchema.optional(),
  inScope: z.boolean(),
});
export type HostNode = z.infer<typeof hostNodeSchema>;

export const serviceNodeSchema = z.strictObject({
  kind: z.literal('service'),
  ...nodeBase,
  hostname: surfaceHostnameSchema,
  port: z.int().min(1).max(LIMITS.portMax),
  protocol: z.enum(PROTOCOLS),
  transport: token(LIMITS.shortTextMax).optional(),
  banner: surfaceBannerSchema.optional(),
});
export type ServiceNode = z.infer<typeof serviceNodeSchema>;

export const technologyNodeSchema = z.strictObject({
  kind: z.literal('technology'),
  ...nodeBase,
  name: token(LIMITS.shortTextMax),
  version: token(LIMITS.shortTextMax).optional(),
  cpe: z
    .string()
    .max(SURFACE_CPE_MAX)
    .refine((value) => value.startsWith(CPE_PREFIX), 'must be a CPE 2.3 string')
    .optional(),
  categories: z.array(token(LIMITS.keyMax)).max(SURFACE_CATEGORIES_MAX),
});
export type TechnologyNode = z.infer<typeof technologyNodeSchema>;

export const endpointNodeSchema = z.strictObject({
  kind: z.literal('endpoint'),
  ...nodeBase,
  assetId: uuidV7Schema,
  method: httpMethodSchema,
  pathTemplate: pathTemplateSchema,
  baseUrl: baseUrlSchema.optional(),
  contentTypes: z.array(contentTypeSchema).max(SURFACE_CONTENT_TYPES_MAX),
  authRequired: z.boolean(),
});
export type EndpointNode = z.infer<typeof endpointNodeSchema>;

/**
 * A parameter stores its name, location and declared type only. Captured values are never modelled:
 * the strict object rejects an `example` key outright (§8.7).
 */
export const parameterNodeSchema = z
  .strictObject({
    kind: z.literal('parameter'),
    ...nodeBase,
    endpointKey: z.string().min(1).max(SURFACE_KEY_MAX),
    name: token(LIMITS.parameterMax),
    location: z.enum(PARAMETER_LOCATIONS),
    dataType: token(LIMITS.keyMax).optional(),
  })
  .superRefine((node, ctx) => {
    if (!node.endpointKey.startsWith(`endpoint:${node.tenantId}:`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endpointKey'],
        message: 'endpointKey must reference an endpoint of the same tenant',
      });
    }
  });
export type ParameterNode = z.infer<typeof parameterNodeSchema>;

export const roleNodeSchema = z.strictObject({
  kind: z.literal('role'),
  ...nodeBase,
  assetId: uuidV7Schema,
  roleName: token(LIMITS.shortTextMax),
});
export type RoleNode = z.infer<typeof roleNodeSchema>;

export const surfaceNodeSchema = z.discriminatedUnion('kind', [
  assetNodeSchema,
  hostNodeSchema,
  serviceNodeSchema,
  technologyNodeSchema,
  endpointNodeSchema,
  parameterNodeSchema,
  roleNodeSchema,
]);
export type SurfaceNode = z.infer<typeof surfaceNodeSchema>;

// ---------------------------------------------------------------------------------------------
// Natural keys (GRAPH-002 uniqueness constraints)
// ---------------------------------------------------------------------------------------------

/**
 * The composite key of a node: the MERGE key in the graph and the `endpointKey` parameters refer to.
 * Components are joined by `:`. A free-text component that can hold a `:` is percent-encoded when it
 * is not the last component.
 */
export function naturalKey(node: SurfaceNode): string {
  const prefix = `${node.kind}:${node.tenantId}`;
  switch (node.kind) {
    case 'asset':
      return `${prefix}:${node.assetId}`;
    case 'host':
      return `${prefix}:${node.hostname}`;
    case 'service':
      return `${prefix}:${node.hostname}:${node.port}:${node.protocol}`;
    case 'technology':
      return `${prefix}:${encodeURIComponent(node.name)}:${node.version ?? ''}`;
    case 'endpoint':
      return `${prefix}:${node.assetId}:${node.method}:${node.pathTemplate}`;
    case 'parameter':
      return `${prefix}:${encodeURIComponent(node.endpointKey)}:${node.location}:${node.name}`;
    case 'role':
      return `${prefix}:${node.assetId}:${node.roleName}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Edge schemas
// ---------------------------------------------------------------------------------------------

/** The node kinds each edge may join, as `[from, to]` pairs. */
const SURFACE_EDGE_ENDPOINTS: Readonly<
  Record<SurfaceEdgeKind, readonly (readonly [SurfaceNodeKind, SurfaceNodeKind])[]>
> = {
  RESOLVES_TO: [['asset', 'host']],
  EXPOSES: [['host', 'service']],
  RUNS: [['service', 'technology']],
  SERVES: [
    ['service', 'endpoint'],
    ['asset', 'endpoint'],
  ],
  HAS_PARAM: [['endpoint', 'parameter']],
  CAN_ACCESS: [['role', 'endpoint']],
};

const edgeKeySchema = z.string().min(1).max(SURFACE_KEY_MAX);

interface EdgeKeys {
  readonly tenantId: string;
  readonly fromKey: string;
  readonly toKey: string;
}

/** Adds an issue unless the edge joins two keys of an allowed kind pair in its own tenant (§8.6). */
function checkLinkedKeys(kind: SurfaceEdgeKind, edge: EdgeKeys, ctx: z.RefinementCtx): void {
  const pairs = SURFACE_EDGE_ENDPOINTS[kind];
  const linked = pairs.some(
    ([from, to]) =>
      edge.fromKey.startsWith(`${from}:${edge.tenantId}:`) &&
      edge.toKey.startsWith(`${to}:${edge.tenantId}:`),
  );
  if (!linked) {
    ctx.addIssue({
      code: 'custom',
      path: ['toKey'],
      message: `${kind} must join ${pairs.map(([from, to]) => `${from} to ${to}`).join(' or ')} keys of one tenant`,
    });
  }
}

const edgeBase = <const K extends SurfaceEdgeKind>(kind: K) =>
  ({
    kind: z.literal(kind),
    ...nodeBase,
    fromKey: edgeKeySchema,
    toKey: edgeKeySchema,
  }) as const;

export const resolvesToEdgeSchema = z
  .strictObject({ ...edgeBase('RESOLVES_TO') })
  .superRefine((edge, ctx) => {
    checkLinkedKeys('RESOLVES_TO', edge, ctx);
  });
export const exposesEdgeSchema = z
  .strictObject({ ...edgeBase('EXPOSES') })
  .superRefine((edge, ctx) => {
    checkLinkedKeys('EXPOSES', edge, ctx);
  });
export const runsEdgeSchema = z.strictObject({ ...edgeBase('RUNS') }).superRefine((edge, ctx) => {
  checkLinkedKeys('RUNS', edge, ctx);
});
export const servesEdgeSchema = z
  .strictObject({ ...edgeBase('SERVES') })
  .superRefine((edge, ctx) => {
    checkLinkedKeys('SERVES', edge, ctx);
  });
export const hasParamEdgeSchema = z
  .strictObject({ ...edgeBase('HAS_PARAM') })
  .superRefine((edge, ctx) => {
    checkLinkedKeys('HAS_PARAM', edge, ctx);
  });
export const canAccessEdgeSchema = z
  .strictObject({
    ...edgeBase('CAN_ACCESS'),
    /** The F9 matrix expectation: whether the role should reach the endpoint. */
    expected: z.enum(ACCESS_EXPECTATIONS),
  })
  .superRefine((edge, ctx) => {
    checkLinkedKeys('CAN_ACCESS', edge, ctx);
  });
export type ResolvesToEdge = z.infer<typeof resolvesToEdgeSchema>;
export type ExposesEdge = z.infer<typeof exposesEdgeSchema>;
export type RunsEdge = z.infer<typeof runsEdgeSchema>;
export type ServesEdge = z.infer<typeof servesEdgeSchema>;
export type HasParamEdge = z.infer<typeof hasParamEdgeSchema>;
export type CanAccessEdge = z.infer<typeof canAccessEdgeSchema>;

export const surfaceEdgeSchema = z.discriminatedUnion('kind', [
  resolvesToEdgeSchema,
  exposesEdgeSchema,
  runsEdgeSchema,
  servesEdgeSchema,
  hasParamEdgeSchema,
  canAccessEdgeSchema,
]);
export type SurfaceEdge = z.infer<typeof surfaceEdgeSchema>;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * Turns a concrete request path into a template for `endpoint.pathTemplate`: canonical path form,
 * with every segment that is a number, a UUID or a long hex run replaced by `{id}`. Returns `null`
 * when the path is not a valid path.
 *
 * Example: `/users/42/orders/3f9c2a1b4d5e6f70` becomes `/users/{id}/orders/{id}`.
 */
export function templatise(path: string): string | null {
  const result = normalisePath(path);
  if (!result.ok) return null;
  const segments = result.path
    .split('/')
    .slice(1)
    .map((segment) => (ID_SEGMENT.test(segment) ? '{id}' : segment));
  return `/${segments.join('/')}`;
}
