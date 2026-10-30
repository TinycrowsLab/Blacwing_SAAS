import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  naturalKey,
  type SurfaceNode,
  surfaceEdgeSchema,
  surfaceNodeSchema,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import {
  parsedArtefactSchema,
  SPEC_INGESTION_PERSONA,
  toSurfaceGraph,
  type ParsedArtefactInput,
  type SurfaceGraph,
  type SurfaceMapContextInput,
} from './surface-mapper.js';

const TENANT = '018f2a6e-1c00-7000-8000-0000000000e1';
const OTHER_TENANT = '018f2a6e-1c00-7000-8000-0000000000e2';
const ASSET = '018f2a6e-1c02-7000-8000-000000000042';
const RUN = '018f2a6e-1c01-7000-8000-00000000000a';
const MANIFEST = '018f2a6e-1c03-7000-8000-000000000001';
const SEEN = '2026-10-29T10:00:00.000Z';

const context: SurfaceMapContextInput = {
  tenantId: TENANT,
  assetId: ASSET,
  runId: RUN,
  manifestId: MANIFEST,
  artefactKey: 'specs/petstore.yaml',
  tool: 'openapi-parser',
  confidence: 0.9,
  seenAt: SEEN,
};

const petstore: ParsedArtefactInput = {
  specKind: 'openapi',
  title: 'Petstore',
  version: '1.0.0',
  servers: ['https://api.example.test/v1', 'https://staging.example.test/v1'],
  authSchemes: [{ name: 'api_key', schemeType: 'apiKey' }],
  schemas: [{ name: 'Pet', type: 'object' }, { name: 'Error' }],
  operations: [
    {
      method: 'get',
      path: '/pets/{petId}',
      contentTypes: ['application/json'],
      authRequired: true,
      security: ['api_key'],
      parameters: [
        { name: 'petId', location: 'path', dataType: 'integer' },
        { name: 'verbose', location: 'query', dataType: 'boolean' },
      ],
    },
    {
      method: 'POST',
      path: '/pets',
      contentTypes: ['application/json'],
      authRequired: false,
      security: [],
      parameters: [],
    },
  ],
  routes: [
    { file: 'src/routes/pets.ts', handler: 'listPets', method: 'GET', path: '/pets/{petId}' },
    { file: 'src/routes/health.ts', handler: 'health' },
  ],
  configItems: [{ key: 'DATABASE_URL', scope: 'env' }],
};

/** A copy of the object without one key, for testing a missing required field. */
function omit(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

function kindsOf(graph: SurfaceGraph): string[] {
  return graph.nodes.map((node) => node.kind);
}

/** The single node of a kind (the first, when there are several), failing the test when there is none. */
function nodeOf(graph: SurfaceGraph, kind: SurfaceNode['kind'], method?: string): SurfaceNode {
  const found = graph.nodes.find(
    (node) =>
      node.kind === kind &&
      (method === undefined || (node.kind === 'endpoint' && node.method === method)),
  );
  if (found === undefined) throw new Error(`no ${kind} node in the graph`);
  return found;
}

describe('toSurfaceGraph (INGEST-001 mapper)', () => {
  it('maps an OpenAPI artefact to GRAPH-003 nodes and edges that the contract accepts', () => {
    const graph = toSurfaceGraph(petstore, context);

    for (const node of graph.nodes) expect(surfaceNodeSchema.safeParse(node).success).toBe(true);
    for (const edge of graph.edges) expect(surfaceEdgeSchema.safeParse(edge).success).toBe(true);
    expect(kindsOf(graph)).toEqual(
      expect.arrayContaining(['spec_document', 'endpoint', 'parameter']),
    );
    expect(graph.nodes.filter((node) => node.kind === 'endpoint')).toHaveLength(2);
    expect(graph.nodes.filter((node) => node.kind === 'parameter')).toHaveLength(2);
  });

  it('reuses the GRAPH-003 endpoint and parameter, and links them with HAS_PARAM', () => {
    const graph = toSurfaceGraph(petstore, context);
    const endpoint = nodeOf(graph, 'endpoint', 'GET');
    expect(endpoint).toMatchObject({
      assetId: ASSET,
      pathTemplate: '/pets/{petId}',
      baseUrl: 'https://api.example.test/v1',
      authRequired: true,
    });
    const endpointKey = naturalKey(endpoint);
    const hasParam = graph.edges.filter((edge) => edge.kind === 'HAS_PARAM');
    expect(hasParam.map((edge) => edge.fromKey)).toEqual([endpointKey, endpointKey]);
  });

  it('attributes every node and edge to the ingestion persona, the tool and the artefact (§8.9)', () => {
    const graph = toSurfaceGraph(petstore, context);
    for (const item of [...graph.nodes, ...graph.edges]) {
      expect(item.provenance).toMatchObject({
        runId: RUN,
        persona: SPEC_INGESTION_PERSONA,
        tool: 'openapi-parser',
        confidence: 0.9,
        firstSeenAt: SEEN,
        lastSeenAt: SEEN,
        sourceManifestId: MANIFEST,
        sourceArtefactKey: 'specs/petstore.yaml',
      });
    }
  });

  it('defines every endpoint, parameter, schema and auth scheme in the spec document', () => {
    const graph = toSurfaceGraph(petstore, context);
    const specKey = naturalKey(nodeOf(graph, 'spec_document'));
    const definedIn = graph.edges.filter((edge) => edge.kind === 'DEFINED_IN');
    expect(definedIn.every((edge) => edge.toKey === specKey)).toBe(true);
    // 2 endpoints, 2 parameters, 2 schemas, 1 auth scheme.
    expect(definedIn).toHaveLength(7);
  });

  it('links a secured operation to its auth scheme and leaves an open one unlinked', () => {
    const graph = toSurfaceGraph(petstore, context);
    const secured = graph.edges.filter((edge) => edge.kind === 'SECURED_BY');
    expect(secured).toHaveLength(1);
    expect(secured[0]?.toKey).toMatch(/^auth_scheme:/);
  });

  it('maps a route with a method and a path to the endpoint it handles, without a second endpoint', () => {
    const graph = toSurfaceGraph(petstore, context);
    const mapsTo = graph.edges.filter((edge) => edge.kind === 'MAPS_TO');
    expect(mapsTo).toHaveLength(1);
    const endpointKeys = graph.nodes
      .filter((node) => node.kind === 'endpoint')
      .map((node) => naturalKey(node));
    expect(endpointKeys).toContain(mapsTo[0]?.toKey);
    const routes = graph.nodes.filter((node) => node.kind === 'source_route');
    expect(routes).toHaveLength(2);
  });

  it('emits zero nodes and edges for an empty artefact', () => {
    expect(toSurfaceGraph({}, context)).toEqual({ nodes: [], edges: [] });
  });

  it('emits the nodes it can read from a partial artefact', () => {
    const graph = toSurfaceGraph({ configItems: [{ key: 'LOG_LEVEL', scope: 'env' }] }, context);
    expect(kindsOf(graph)).toEqual(['config_item']);
    expect(graph.edges).toEqual([]);
  });

  it('gives the same output whatever order the parser emitted items in', () => {
    const reversed: ParsedArtefactInput = {
      ...petstore,
      operations: [...(petstore.operations ?? [])].reverse(),
      schemas: [...(petstore.schemas ?? [])].reverse(),
      routes: [...(petstore.routes ?? [])].reverse(),
    };
    expect(toSurfaceGraph(reversed, context)).toEqual(toSurfaceGraph(petstore, context));
  });

  it('collapses a node or edge that appears twice in one batch to one', () => {
    const doubled: ParsedArtefactInput = {
      ...petstore,
      operations: [...(petstore.operations ?? []), ...(petstore.operations ?? [])],
    };
    const once = toSurfaceGraph(petstore, context);
    const twice = toSurfaceGraph(doubled, context);
    expect(twice.nodes.map((node) => naturalKey(node))).toEqual(
      once.nodes.map((node) => naturalKey(node)),
    );
    expect(twice.edges.map((edge) => `${edge.kind}${edge.fromKey}${edge.toKey}`)).toEqual(
      once.edges.map((edge) => `${edge.kind}${edge.fromKey}${edge.toKey}`),
    );
  });

  it('keeps every node tied to the tenant of the context and rejects a tenant-less context', () => {
    const graph = toSurfaceGraph(petstore, context);
    for (const node of graph.nodes) expect(node.tenantId).toBe(TENANT);
    expect(() => toSurfaceGraph(petstore, { ...context, tenantId: 'not-a-tenant' })).toThrow(
      AppError,
    );
    expect(
      toSurfaceGraph(petstore, { ...context, tenantId: OTHER_TENANT }).nodes[0]?.tenantId,
    ).toBe(OTHER_TENANT);
    const withoutTenant = omit(context, 'tenantId');
    expect(() => toSurfaceGraph(petstore, withoutTenant as SurfaceMapContextInput)).toThrow(
      /surface map context/,
    );
  });

  it('refuses an operation that names an auth scheme the artefact does not declare', () => {
    const broken: ParsedArtefactInput = {
      ...petstore,
      authSchemes: [],
    };
    expect(() => toSurfaceGraph(broken, context)).toThrow(/unknown auth scheme/);
  });

  it('refuses an operation path that is not a valid path, and emits nothing', () => {
    const broken: ParsedArtefactInput = {
      ...petstore,
      operations: [
        { method: 'GET', path: '/bad\u0001path', contentTypes: [], authRequired: false },
      ],
    };
    expect(() => toSurfaceGraph(broken, context)).toThrow(/invalid operation path/);
  });

  it('refuses an artefact with operations but no spec kind', () => {
    const rest = omit(petstore, 'specKind');
    expect(parsedArtefactSchema.safeParse(rest).success).toBe(false);
    expect(() => toSurfaceGraph(rest, context)).toThrow(/invalid parsed artefact/);
  });

  it('refuses a route that names only a method or only a path', () => {
    const halfRoute: ParsedArtefactInput = {
      routes: [{ file: 'src/a.ts', handler: 'h', method: 'GET' }],
    };
    expect(parsedArtefactSchema.safeParse(halfRoute).success).toBe(false);
  });

  it('refuses a value or example field (§8.7): the parser schema is strict', () => {
    const withExample = {
      specKind: 'openapi',
      schemas: [{ name: 'Pet', example: { name: 'rex' } }],
    };
    expect(parsedArtefactSchema.safeParse(withExample).success).toBe(false);
    const withValue = { configItems: [{ key: 'DATABASE_URL', scope: 'env', value: 'x' }] };
    expect(parsedArtefactSchema.safeParse(withValue).success).toBe(false);
  });

  it('refuses an empty source artefact key, since every spec-ingestion key is scoped by it', () => {
    expect(() => toSurfaceGraph(petstore, { ...context, artefactKey: '' })).toThrow(AppError);
  });

  it('keeps the parser file free of Cypher and of the driver (INGEST boundary)', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(dir, 'surface-mapper.ts'), 'utf8');
    expect(source).not.toMatch(/MERGE/);
    expect(source).not.toMatch(/neo4j-driver/);
  });

  it('has no second writer: the ingest folder only imports the GRAPH-005 repository', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    expect(existsSync(join(dir, 'surface-writer.ts'))).toBe(false);
    const files = readdirSync(dir).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source).not.toMatch(/MERGE\s*\(/);
      expect(source).not.toMatch(/neo4j-driver/);
      const graphImports = [...source.matchAll(/from '(\.\.\/graph\/[^']+)'/g)].map(
        (match) => match[1],
      );
      expect(graphImports.every((path) => path === '../graph/repository.js')).toBe(true);
    }
  });
});
