import { z } from 'zod';

import {
  isoDateTimeSchema,
  normaliseIp,
  type ScopeRule,
  type ScopeRules,
  type ScopeTarget,
  uuidV7Schema,
} from '@blackwing/contracts';
import { ScopeViolationError, TenantContextMissingError, ValidationError } from '@blackwing/errors';

import { SurfaceBatchTooLargeError } from './errors.js';
import {
  endpointKey,
  hostKey,
  PARAMETER_LOCATIONS,
  parameterKey,
  roleKey,
  SERVICE_PROTOS,
  serviceKey,
  technologyKey,
} from './fingerprint.js';
import { canonicalAddress, canonicalMethod, parseSurfaceUrl } from './normalise.js';
import { matchScope } from '../scope/matcher.js';

/** In-process MCP tool recon uses to write the surface model (MCP epic, GRAPH owns storage). */
export const WRITE_SURFACE_TOOL = 'mcp__blackwing__write_surface';
export const SURFACE_MAX_NODES = 500;
export const SURFACE_MAX_EDGES = 1000;
/** Counter incremented per node written. */
export const SURFACE_WRITE_METRIC = 'recon_surface_write_total';
export const SURFACE_WRITE_METRIC_LABELS = ['persona', 'nodeType'] as const;

const ADDRESS_MAX = 255;
const NAME_MAX = 128;
const PORT_MAX = 65_535;
const METHOD_MAX = 16;
const URL_MAX = 8192;
const PARAM_NAME_MAX = 256;
const SHORT_MAX = 64;

const str = (max: number): z.ZodString => z.string().min(1).max(max);
const assetId = uuidV7Schema;
const ipAddress = z
  .string()
  .refine((value) => normaliseIp(value) !== null, 'must be an IPv4 or IPv6 address');
const keyHex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 key');

/** Recon-side view of a surface node; the fingerprint key is derived, never supplied. */
export const surfaceNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('host'),
    assetId,
    address: str(ADDRESS_MAX),
    /** The single IP a hostname resolved to and was pinned to (anti-rebinding, §8.2); not part of the key. */
    pinnedIp: ipAddress.optional(),
  }),
  z.strictObject({
    type: z.literal('service'),
    assetId,
    address: str(ADDRESS_MAX),
    port: z.int().min(1).max(PORT_MAX),
    proto: z.enum(SERVICE_PROTOS),
    name: str(NAME_MAX).optional(),
  }),
  z.strictObject({
    type: z.literal('endpoint'),
    assetId,
    method: str(METHOD_MAX),
    url: str(URL_MAX),
  }),
  z.strictObject({
    type: z.literal('parameter'),
    assetId,
    method: str(METHOD_MAX),
    url: str(URL_MAX),
    location: z.enum(PARAMETER_LOCATIONS),
    name: str(PARAM_NAME_MAX),
  }),
  z.strictObject({
    type: z.literal('technology'),
    assetId,
    address: str(ADDRESS_MAX),
    product: str(NAME_MAX),
    version: str(SHORT_MAX).optional(),
  }),
  z.strictObject({ type: z.literal('role'), assetId, roleName: str(NAME_MAX) }),
]);
export type SurfaceNode = z.infer<typeof surfaceNodeSchema>;
type SurfaceNodeType = SurfaceNode['type'];

/** Edge between two fingerprint keys (the nodes may already exist in the graph). */
export const surfaceEdgeSchema = z.strictObject({
  type: z.enum(['exposes', 'serves', 'accepts', 'runs', 'accessible_by']),
  from: keyHex,
  to: keyHex,
});
export type SurfaceEdge = z.infer<typeof surfaceEdgeSchema>;

const surfaceProvenanceSchema = z.strictObject({
  runId: uuidV7Schema,
  sessionId: uuidV7Schema,
  persona: str(SHORT_MAX),
  tool: str(NAME_MAX),
  toolVersion: str(SHORT_MAX),
  confidence: z.number().min(0).max(1),
  observedAt: isoDateTimeSchema,
});
export type SurfaceProvenance = z.infer<typeof surfaceProvenanceSchema>;

export const surfaceWriteRequestSchema = z.strictObject({
  nodes: z.array(surfaceNodeSchema),
  edges: z.array(surfaceEdgeSchema),
  provenance: surfaceProvenanceSchema,
});
export type SurfaceWriteRequest = z.infer<typeof surfaceWriteRequestSchema>;

/** The deterministic fingerprint key of a node (see RECON-002). */
export function surfaceNodeKey(node: SurfaceNode): string {
  switch (node.type) {
    case 'host':
      return hostKey(node.assetId, node.address);
    case 'service':
      return serviceKey(hostKey(node.assetId, node.address), node.port, node.proto);
    case 'endpoint':
      return endpointKey(node.assetId, node.method, node.url);
    case 'parameter':
      return parameterKey(
        endpointKey(node.assetId, node.method, node.url),
        node.location,
        node.name,
      );
    case 'technology':
      return technologyKey(hostKey(node.assetId, node.address), node.product, node.version);
    case 'role':
      return roleKey(node.assetId, node.roleName);
  }
}

/**
 * The rules as they apply to a node that names an address but no port, path or method (host, technology).
 * An include counts for the address whatever it constrains further; an exclude only counts when it excludes the
 * whole address. Without this a port-restricted scope (`include host, ports [80, 443]`) would reject every host
 * node, because the matcher never lets a missing port satisfy an include. Probes and service/endpoint nodes keep
 * the full check. Also used to decide whether a name may be resolved at all.
 */
export function addressRules(scope: ScopeRules): ScopeRules {
  return {
    rules: scope.rules.flatMap((rule): ScopeRule[] => {
      const constrained =
        rule.ports !== undefined || rule.paths !== undefined || rule.methods !== undefined;
      if (rule.effect === 'exclude' && constrained) return [];
      return [
        {
          effect: rule.effect,
          ...(rule.host === undefined ? {} : { host: rule.host }),
          ...(rule.cidr === undefined ? {} : { cidr: rule.cidr }),
        },
      ];
    }),
  };
}

function addressTarget(address: string): ScopeTarget {
  return address.includes(':') || /^[0-9.]+$/.test(address) ? { ip: address } : { host: address };
}

/** The network target a node refers to, or `null` for nodes that touch no host (roles). */
function scopeTarget(node: SurfaceNode): ScopeTarget | null {
  switch (node.type) {
    case 'role':
      return null;
    case 'host':
    case 'technology':
    case 'service': {
      const base = addressTarget(canonicalAddress(node.address));
      return node.type === 'service' ? { ...base, port: node.port } : base;
    }
    case 'endpoint':
    case 'parameter': {
      const url = parseSurfaceUrl(node.url);
      return {
        ...addressTarget(url.host),
        port: url.port,
        path: url.path,
        method: canonicalMethod(node.method),
      };
    }
  }
}

/** A node written with its derived key, as sent to the tool. */
type KeyedSurfaceNode = SurfaceNode & { readonly key: string };

export interface SurfaceAuditEvent {
  readonly action: 'recon.surface_write.denied';
  readonly tenantId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly persona: string;
  readonly nodeType: SurfaceNodeType;
  readonly reason: string;
}

export interface SurfaceWriteContext {
  /** Tenant of the run; every write is scoped to it (§8.6). Missing or malformed fails closed. */
  readonly tenantId: string;
  /** The run envelope's scope; any node outside it rejects the whole batch. */
  readonly scope: ScopeRules;
  /** Calls the in-process MCP tool; the tenant context rides alongside the request. */
  readonly callTool: (
    tool: typeof WRITE_SURFACE_TOOL,
    input: {
      readonly tenantId: string;
      readonly request: Omit<SurfaceWriteRequest, 'nodes'> & { readonly nodes: KeyedSurfaceNode[] };
    },
  ) => Promise<unknown>;
  /** Records a denied write in the audit trail. */
  readonly audit: (event: SurfaceAuditEvent) => void | Promise<void>;
  /** Increments {@link SURFACE_WRITE_METRIC}. */
  readonly increment?: (
    metric: typeof SURFACE_WRITE_METRIC,
    labels: { persona: string; nodeType: SurfaceNodeType },
    by: number,
  ) => void;
  /** Structured log line: `runId,sessionId,persona,nodeCount,edgeCount`. */
  readonly log?: (fields: {
    runId: string;
    sessionId: string;
    persona: string;
    nodeCount: number;
    edgeCount: number;
  }) => void;
}

export interface SurfaceWriteResult {
  readonly nodeCount: number;
  readonly edgeCount: number;
}

function lengthOf(value: unknown, key: string): number {
  const list = (value as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(list) ? list.length : 0;
}

/**
 * Validates and writes a surface batch through `mcp__blackwing__write_surface`.
 * Order: tenant context, batch caps, Zod, scope check on every node (all-or-nothing), call.
 * An empty batch is a no-op success.
 * @throws {TenantContextMissingError} no/malformed tenant id.
 * @throws {SurfaceBatchTooLargeError} over 500 nodes or 1000 edges.
 * @throws {ValidationError} schema failure; {@link InvalidSurfaceInputError} for bad URLs/hosts.
 * @throws {ScopeViolationError} a node references something outside the envelope (audited).
 */
export async function writeSurface(
  ctx: SurfaceWriteContext,
  input: unknown,
): Promise<SurfaceWriteResult> {
  if (!uuidV7Schema.safeParse(ctx.tenantId).success) {
    throw new TenantContextMissingError('surface write requires a tenant context', {
      reason: ctx.tenantId ? 'invalid_uuid' : 'missing',
    });
  }
  if (lengthOf(input, 'nodes') > SURFACE_MAX_NODES) {
    throw new SurfaceBatchTooLargeError(`surface batch exceeds ${SURFACE_MAX_NODES} nodes`);
  }
  if (lengthOf(input, 'edges') > SURFACE_MAX_EDGES) {
    throw new SurfaceBatchTooLargeError(`surface batch exceeds ${SURFACE_MAX_EDGES} edges`);
  }
  const parsed = surfaceWriteRequestSchema.safeParse(input);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new ValidationError(`invalid surface write at ${paths.join(', ')}`);
  }
  const request = parsed.data;
  const { provenance } = request;
  const nodeCount = request.nodes.length;
  const edgeCount = request.edges.length;
  if (nodeCount === 0 && edgeCount === 0) return { nodeCount: 0, edgeCount: 0 };

  const keyed: KeyedSurfaceNode[] = [];
  for (const node of request.nodes) {
    const target = scopeTarget(node);
    if (target !== null) {
      const addressOnly = node.type === 'host' || node.type === 'technology';
      const decision = matchScope(target, addressOnly ? addressRules(ctx.scope) : ctx.scope);
      if (!decision.inScope) {
        await ctx.audit({
          action: 'recon.surface_write.denied',
          tenantId: ctx.tenantId,
          runId: provenance.runId,
          sessionId: provenance.sessionId,
          persona: provenance.persona,
          nodeType: node.type,
          reason: decision.reason,
        });
        throw new ScopeViolationError(
          'surface node references a target outside the envelope scope',
        );
      }
    }
    keyed.push({ ...node, key: surfaceNodeKey(node) });
  }

  await ctx.callTool(WRITE_SURFACE_TOOL, {
    tenantId: ctx.tenantId,
    request: { ...request, nodes: keyed },
  });

  const byType = new Map<SurfaceNodeType, number>();
  for (const node of request.nodes) byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
  for (const [nodeType, count] of byType) {
    ctx.increment?.(SURFACE_WRITE_METRIC, { persona: provenance.persona, nodeType }, count);
  }
  ctx.log?.({
    runId: provenance.runId,
    sessionId: provenance.sessionId,
    persona: provenance.persona,
    nodeCount,
    edgeCount,
  });
  return { nodeCount, edgeCount };
}
