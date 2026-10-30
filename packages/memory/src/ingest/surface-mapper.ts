import { z } from 'zod';

import {
  httpMethodSchema,
  isoDateTimeSchema,
  LIMITS,
  naturalKey,
  PARAMETER_LOCATIONS,
  SPEC_KINDS,
  type SurfaceEdge,
  surfaceEdgeSchema,
  type SurfaceNode,
  surfaceNodeSchema,
  templatise,
  uuidV7Schema,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

/**
 * The persona every spec-ingestion fact is attributed to (§4.6). Importers never choose their own.
 */
export const SPEC_INGESTION_PERSONA = 'source-spec-ingestion';

/** Most items of one kind an artefact may carry. A larger artefact is refused, never truncated. */
export const INGEST_ITEMS_MAX = 10_000;

const text = (max: number): z.ZodString => z.string().min(1).max(max);
const keyText = text(LIMITS.keyMax);

/**
 * What a parser read from one artefact. Parsers (INGEST-003..009) produce this shape; names, types and references
 * only. A value, a sample or a secret has no field here (§8.7), and the strict objects reject one outright.
 */
export const parsedArtefactSchema = z
  .strictObject({
    /** Present when the artefact is an API description. Its spec document node is then emitted. */
    specKind: z.enum(SPEC_KINDS).optional(),
    title: text(LIMITS.shortTextMax).optional(),
    version: text(LIMITS.shortTextMax).optional(),
    /** Absolute base URLs from the spec's servers. The first one becomes each endpoint's `baseUrl`. */
    servers: z.array(text(LIMITS.urlMax)).max(INGEST_ITEMS_MAX).default([]),
    operations: z
      .array(
        z.strictObject({
          method: httpMethodSchema,
          path: text(LIMITS.urlMax),
          contentTypes: z.array(text(LIMITS.keyMax)).default([]),
          authRequired: z.boolean(),
          /** Names of the auth schemes that secure this operation. Each must be a declared scheme. */
          security: z.array(text(LIMITS.shortTextMax)).default([]),
          parameters: z
            .array(
              z.strictObject({
                name: text(LIMITS.parameterMax),
                location: z.enum(PARAMETER_LOCATIONS),
                dataType: keyText.optional(),
              }),
            )
            .default([]),
        }),
      )
      .max(INGEST_ITEMS_MAX)
      .default([]),
    schemas: z
      .array(
        z.strictObject({
          name: text(LIMITS.parameterMax),
          type: keyText.optional(),
        }),
      )
      .max(INGEST_ITEMS_MAX)
      .default([]),
    authSchemes: z
      .array(
        z.strictObject({
          name: text(LIMITS.shortTextMax),
          schemeType: keyText,
        }),
      )
      .max(INGEST_ITEMS_MAX)
      .default([]),
    /** Source routes. A route with both `method` and `path` is linked to the endpoint it handles. */
    routes: z
      .array(
        z
          .strictObject({
            file: text(LIMITS.urlMax),
            handler: keyText,
            method: httpMethodSchema.optional(),
            path: text(LIMITS.urlMax).optional(),
          })
          .refine((route) => (route.method === undefined) === (route.path === undefined), {
            message: 'a route names both its method and its path, or neither',
          }),
      )
      .max(INGEST_ITEMS_MAX)
      .default([]),
    configItems: z
      .array(
        z.strictObject({
          key: text(LIMITS.parameterMax),
          scope: text(LIMITS.shortTextMax),
        }),
      )
      .max(INGEST_ITEMS_MAX)
      .default([]),
  })
  .superRefine((artefact, ctx) => {
    if (artefact.specKind !== undefined) return;
    const specOnly = [
      ['servers', artefact.servers],
      ['operations', artefact.operations],
      ['schemas', artefact.schemas],
      ['authSchemes', artefact.authSchemes],
    ] as const;
    for (const [field, items] of specOnly) {
      if (items.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'an artefact without a specKind carries no spec items',
        });
      }
    }
  });
export type ParsedArtefact = z.infer<typeof parsedArtefactSchema>;
export type ParsedArtefactInput = z.input<typeof parsedArtefactSchema>;

/** The tenant, asset, run and artefact context a parsed artefact is mapped in. */
export const surfaceMapContextSchema = z.strictObject({
  tenantId: uuidV7Schema,
  assetId: uuidV7Schema,
  runId: uuidV7Schema,
  manifestId: uuidV7Schema,
  /** The artefact within the manifest, as the manifest names it. */
  artefactKey: keyText,
  /** The parser that read the artefact (`openapi-parser`, `route-scanner`...). */
  tool: keyText,
  confidence: z.number().min(0).max(1),
  seenAt: isoDateTimeSchema,
  agentSessionId: keyText.optional(),
});
export type SurfaceMapContext = z.infer<typeof surfaceMapContextSchema>;
export type SurfaceMapContextInput = z.input<typeof surfaceMapContextSchema>;

/** The GRAPH-003 nodes and edges of one artefact, one per natural key, in key order. */
export interface SurfaceGraph {
  readonly nodes: readonly SurfaceNode[];
  readonly edges: readonly SurfaceEdge[];
}

/**
 * Maps one parsed artefact to GRAPH-003 nodes and edges. Pure: no transaction, no Cypher and no driver. The result is
 * written through the GRAPH-005 upsert, which owns idempotency, so this function holds no second key scheme.
 *
 * Within one batch, a node or edge that appears more than once is collapsed to one. The survivor is the candidate
 * whose JSON sorts first, so the output does not depend on the order the parser emitted items in.
 *
 * Throws `VALIDATION_FAILED` when the artefact or the context is malformed, when an operation names an unknown auth
 * scheme, or when an item breaks the contract. Nothing is returned in that case, so a partial graph is never written.
 */
export function toSurfaceGraph(
  artefactInput: ParsedArtefactInput,
  contextInput: SurfaceMapContextInput,
): SurfaceGraph {
  const artefact = parseOrRefuse(parsedArtefactSchema, artefactInput, 'parsed artefact');
  const context = parseOrRefuse(surfaceMapContextSchema, contextInput, 'surface map context');
  const provenance = provenanceOf(context);
  const nodes: SurfaceNode[] = [];
  const edges: SurfaceEdge[] = [];
  const add = (node: unknown): SurfaceNode => {
    const parsed = parseOrRefuse(surfaceNodeSchema, node, 'surface node');
    nodes.push(parsed);
    return parsed;
  };
  const link = (edge: unknown): void => {
    edges.push(parseOrRefuse(surfaceEdgeSchema, edge, 'surface edge'));
  };

  const spec =
    artefact.specKind === undefined
      ? undefined
      : add({
          kind: 'spec_document',
          tenantId: context.tenantId,
          provenance,
          specKind: artefact.specKind,
          title: artefact.title,
          version: artefact.version,
        });
  const specKey = spec === undefined ? undefined : naturalKey(spec);
  const definedIn = (fromKey: string): void => {
    if (specKey !== undefined)
      link({ kind: 'DEFINED_IN', tenantId: context.tenantId, provenance, fromKey, toKey: specKey });
  };

  const authKeys = new Map<string, string>();
  for (const scheme of artefact.authSchemes) {
    const node = add({
      kind: 'auth_scheme',
      tenantId: context.tenantId,
      provenance,
      schemeType: scheme.schemeType,
      name: scheme.name,
    });
    authKeys.set(scheme.name, naturalKey(node));
    definedIn(naturalKey(node));
  }

  const baseUrl = artefact.servers[0];
  for (const operation of artefact.operations) {
    const pathTemplate = templatise(operation.path);
    if (pathTemplate === null) {
      throw refusal(`invalid operation path ${JSON.stringify(operation.path)}`);
    }
    const endpoint = add({
      kind: 'endpoint',
      tenantId: context.tenantId,
      provenance,
      assetId: context.assetId,
      method: operation.method,
      pathTemplate,
      baseUrl,
      contentTypes: operation.contentTypes,
      authRequired: operation.authRequired,
    });
    const endpointKey = naturalKey(endpoint);
    definedIn(endpointKey);
    for (const schemeName of operation.security) {
      const authKey = authKeys.get(schemeName);
      if (authKey === undefined) throw refusal(`unknown auth scheme ${JSON.stringify(schemeName)}`);
      link({
        kind: 'SECURED_BY',
        tenantId: context.tenantId,
        provenance,
        fromKey: endpointKey,
        toKey: authKey,
      });
    }
    for (const parameter of operation.parameters) {
      const node = add({
        kind: 'parameter',
        tenantId: context.tenantId,
        provenance,
        endpointKey,
        name: parameter.name,
        location: parameter.location,
        dataType: parameter.dataType,
      });
      link({
        kind: 'HAS_PARAM',
        tenantId: context.tenantId,
        provenance,
        fromKey: endpointKey,
        toKey: naturalKey(node),
      });
      definedIn(naturalKey(node));
    }
  }

  for (const schema of artefact.schemas) {
    const node = add({
      kind: 'schema_object',
      tenantId: context.tenantId,
      provenance,
      name: schema.name,
      type: schema.type,
    });
    definedIn(naturalKey(node));
  }

  for (const route of artefact.routes) {
    const node = add({
      kind: 'source_route',
      tenantId: context.tenantId,
      provenance,
      file: route.file,
      handler: route.handler,
    });
    if (route.method !== undefined && route.path !== undefined) {
      const endpointKey = endpointKeyOf(
        context.assetId,
        route.method,
        route.path,
        context.tenantId,
        provenance,
      );
      link({
        kind: 'MAPS_TO',
        tenantId: context.tenantId,
        provenance,
        fromKey: naturalKey(node),
        toKey: endpointKey,
      });
    }
  }

  for (const item of artefact.configItems) {
    add({
      kind: 'config_item',
      tenantId: context.tenantId,
      provenance,
      key: item.key,
      scope: item.scope,
    });
  }

  return { nodes: collapse(nodes, naturalKey), edges: collapse(edges, edgeKey) };
}

/** The provenance every node and edge of one artefact carries. Optional fields are set only when known. */
function provenanceOf(context: SurfaceMapContext): Record<string, unknown> {
  return {
    runId: context.runId,
    ...(context.agentSessionId === undefined ? {} : { agentSessionId: context.agentSessionId }),
    persona: SPEC_INGESTION_PERSONA,
    tool: context.tool,
    confidence: context.confidence,
    firstSeenAt: context.seenAt,
    lastSeenAt: context.seenAt,
    sourceManifestId: context.manifestId,
    sourceArtefactKey: context.artefactKey,
  };
}

/** The natural key of an endpoint that a source route names. The endpoint itself is not emitted (see MAPS_TO). */
function endpointKeyOf(
  assetId: string,
  method: string,
  path: string,
  tenantId: string,
  provenance: Record<string, unknown>,
): string {
  const endpoint = surfaceNodeSchema.safeParse({
    kind: 'endpoint',
    tenantId,
    provenance,
    assetId,
    method,
    pathTemplate: templatise(path) ?? path,
    contentTypes: [],
    authRequired: false,
  });
  if (!endpoint.success) throw refusal('invalid route endpoint', endpoint.error);
  return naturalKey(endpoint.data);
}

/** The edge identity of GRAPH-005: the kind and both endpoints. */
function edgeKey(edge: SurfaceEdge): string {
  return `${edge.kind}|${edge.fromKey}|${edge.toKey}`;
}

/**
 * Keeps one item per key. The survivor is the candidate whose JSON sorts first, so the choice is the same whatever
 * the input order. Results are returned in key order.
 */
function collapse<T extends SurfaceNode | SurfaceEdge>(
  items: readonly T[],
  key: (item: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    const current = byKey.get(id);
    if (current === undefined || JSON.stringify(item) < JSON.stringify(current))
      byKey.set(id, item);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item);
}

function parseOrRefuse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw refusal(`invalid ${what}`, parsed.error);
  }
  return parsed.data;
}

function refusal(message: string, cause?: unknown): AppError {
  return new AppError('VALIDATION_FAILED', `spec ingestion: ${message}`, { cause });
}
