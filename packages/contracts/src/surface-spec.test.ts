import { describe, expect, it } from 'vitest';

import {
  authSchemeNodeSchema,
  configItemNodeSchema,
  definedInEdgeSchema,
  endpointNodeSchema,
  mapsToEdgeSchema,
  naturalKey,
  SURFACE_CONTRACT_VERSION,
  SURFACE_EDGE_KINDS,
  SURFACE_NODE_KINDS,
  schemaObjectNodeSchema,
  securedByEdgeSchema,
  type SurfaceNode,
  sourceRouteNodeSchema,
  specDocumentNodeSchema,
  surfaceEdgeSchema,
  surfaceNodeSchema,
} from './index.js';

const TENANT = '018f0000-0000-7000-8000-00000000000a';
const OTHER_TENANT = '018f0000-0000-7000-8000-00000000000b';
const ASSET = '018f0000-0000-7000-8000-0000000000a1';
const RUN = '018f0000-0000-7000-8000-0000000000c1';
const MANIFEST = '018f0000-0000-7000-8000-0000000000d1';
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';

function provenance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: RUN,
    persona: 'source-spec-ingestion',
    tool: 'openapi-parser',
    confidence: 0.9,
    firstSeenAt: T0,
    lastSeenAt: T1,
    sourceManifestId: MANIFEST,
    sourceArtefactKey: 'specs/petstore.yaml',
    ...overrides,
  };
}

const specDoc = {
  kind: 'spec_document',
  tenantId: TENANT,
  provenance: provenance(),
  specKind: 'openapi',
  title: 'Petstore',
  version: '1.0.0',
} as const;

const authScheme = {
  kind: 'auth_scheme',
  tenantId: TENANT,
  provenance: provenance(),
  schemeType: 'apiKey',
  name: 'api_key',
} as const;

const endpoint = {
  kind: 'endpoint',
  tenantId: TENANT,
  provenance: provenance(),
  assetId: ASSET,
  method: 'GET',
  pathTemplate: '/pets/{id}',
  contentTypes: ['application/json'],
  authRequired: true,
} as const;

const endpointKey = `endpoint:${TENANT}:${ASSET}:GET:/pets/{id}`;
const specKey = `spec_document:${TENANT}:${encodeURIComponent('specs/petstore.yaml')}`;

describe('spec-ingestion contract (INGEST-001)', () => {
  it('bumps the contract to a minor version and keeps the existing kinds', () => {
    expect(SURFACE_CONTRACT_VERSION).toBe('1.1.0');
    expect(SURFACE_NODE_KINDS).toEqual(
      expect.arrayContaining([
        'asset',
        'host',
        'service',
        'technology',
        'endpoint',
        'parameter',
        'role',
      ]),
    );
    expect(SURFACE_NODE_KINDS).toEqual(
      expect.arrayContaining([
        'spec_document',
        'schema_object',
        'auth_scheme',
        'source_route',
        'config_item',
      ]),
    );
    expect(SURFACE_EDGE_KINDS).toEqual(
      expect.arrayContaining(['DEFINED_IN', 'SECURED_BY', 'MAPS_TO', 'HAS_PARAM', 'CAN_ACCESS']),
    );
  });

  it('accepts each new node kind with its shared provenance', () => {
    const nodes = [
      specDoc,
      {
        kind: 'schema_object',
        tenantId: TENANT,
        provenance: provenance(),
        name: 'Pet',
        type: 'object',
      },
      authScheme,
      {
        kind: 'source_route',
        tenantId: TENANT,
        provenance: provenance({ tool: 'route-scanner' }),
        file: 'src/routes/pets.ts',
        handler: 'listPets',
      },
      {
        kind: 'config_item',
        tenantId: TENANT,
        provenance: provenance({ tool: 'env-scanner' }),
        key: 'DATABASE_URL',
        scope: 'env',
      },
    ];
    for (const node of nodes) {
      expect(surfaceNodeSchema.safeParse(node).success).toBe(true);
    }
  });

  it('rejects a new node that lacks the shared provenance', () => {
    const withoutProvenance = Object.fromEntries(
      Object.entries(specDoc).filter(([key]) => key !== 'provenance'),
    );
    expect(surfaceNodeSchema.safeParse(withoutProvenance).success).toBe(false);
  });

  it('rejects a spec-ingestion node that names no source artefact', () => {
    const detached = { ...specDoc, provenance: provenance({ sourceArtefactKey: undefined }) };
    const result = specDocumentNodeSchema.safeParse(detached);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['provenance', 'sourceArtefactKey']);
  });

  it('rejects an unknown spec kind, a bad manifest id and an out-of-range confidence', () => {
    expect(specDocumentNodeSchema.safeParse({ ...specDoc, specKind: 'wsdl' }).success).toBe(false);
    expect(
      specDocumentNodeSchema.safeParse({
        ...specDoc,
        provenance: provenance({ sourceManifestId: 'not-a-uuid' }),
      }).success,
    ).toBe(false);
    expect(
      specDocumentNodeSchema.safeParse({ ...specDoc, provenance: provenance({ confidence: 1.5 }) })
        .success,
    ).toBe(false);
  });

  it('rejects any stored value or example on a schema or a config item (§8.7)', () => {
    expect(
      schemaObjectNodeSchema.safeParse({
        kind: 'schema_object',
        tenantId: TENANT,
        provenance: provenance(),
        name: 'Pet',
        example: { name: 'rex' },
      }).success,
    ).toBe(false);
    expect(
      configItemNodeSchema.safeParse({
        kind: 'config_item',
        tenantId: TENANT,
        provenance: provenance(),
        key: 'DATABASE_URL',
        scope: 'env',
        value: 'postgres://user:secret@db',
      }).success,
    ).toBe(false);
    expect(authSchemeNodeSchema.safeParse({ ...authScheme, secret: 'abc123' }).success).toBe(false);
  });

  it('rejects a source route that is not a tenant-scoped file and handler', () => {
    expect(
      sourceRouteNodeSchema.safeParse({
        kind: 'source_route',
        tenantId: TENANT,
        provenance: provenance(),
        file: '',
        handler: 'listPets',
      }).success,
    ).toBe(false);
  });

  describe('natural keys', () => {
    it('prefixes each new key with its kind and the tenant', () => {
      expect(naturalKey(specDoc as SurfaceNode)).toBe(specKey);
      expect(naturalKey(authScheme as SurfaceNode)).toBe(
        `auth_scheme:${TENANT}:${encodeURIComponent('specs/petstore.yaml')}:api_key`,
      );
    });

    it('keeps two artefacts of one tenant apart', () => {
      const other = {
        ...specDoc,
        provenance: provenance({ sourceArtefactKey: 'specs/other.yaml' }),
      };
      expect(naturalKey(other as SurfaceNode)).not.toBe(naturalKey(specDoc as SurfaceNode));
    });

    it('does not let a colon in an artefact key or a file name merge two nodes', () => {
      const colonArtefact = {
        ...specDoc,
        provenance: provenance({ sourceArtefactKey: 'a:b' }),
      };
      const plainArtefact = {
        ...specDoc,
        provenance: provenance({ sourceArtefactKey: 'a' }),
      };
      expect(naturalKey(colonArtefact as SurfaceNode)).not.toBe(
        naturalKey(plainArtefact as SurfaceNode),
      );
      const routeA = {
        kind: 'source_route',
        tenantId: TENANT,
        provenance: provenance(),
        file: 'x:y',
        handler: 'z',
      };
      const routeB = { ...routeA, file: 'x', handler: 'y:z' };
      expect(naturalKey(routeA as SurfaceNode)).not.toBe(naturalKey(routeB as SurfaceNode));
    });

    it('gives each node kind a key that starts with its own kind name', () => {
      for (const node of [specDoc, authScheme, endpoint]) {
        const key = naturalKey(surfaceNodeSchema.parse(node));
        expect(key.startsWith(`${node.kind}:${TENANT}:`)).toBe(true);
      }
    });
  });

  describe('edges', () => {
    const definedIn = {
      kind: 'DEFINED_IN',
      tenantId: TENANT,
      provenance: provenance(),
      fromKey: endpointKey,
      toKey: specKey,
    } as const;

    it('accepts DEFINED_IN from an endpoint to its spec document, and SECURED_BY and MAPS_TO', () => {
      expect(surfaceEdgeSchema.safeParse(definedIn).success).toBe(true);
      expect(
        surfaceEdgeSchema.safeParse({
          kind: 'SECURED_BY',
          tenantId: TENANT,
          provenance: provenance(),
          fromKey: endpointKey,
          toKey: `auth_scheme:${TENANT}:${encodeURIComponent('specs/petstore.yaml')}:api_key`,
        }).success,
      ).toBe(true);
      expect(
        surfaceEdgeSchema.safeParse({
          kind: 'MAPS_TO',
          tenantId: TENANT,
          provenance: provenance(),
          fromKey: `source_route:${TENANT}:${encodeURIComponent('specs/petstore.yaml')}:src%2Fa.ts:h`,
          toKey: endpointKey,
        }).success,
      ).toBe(true);
    });

    it('rejects an edge that joins the wrong kinds', () => {
      expect(
        definedInEdgeSchema.safeParse({ ...definedIn, fromKey: `host:${TENANT}:api.example.test` })
          .success,
      ).toBe(false);
      expect(securedByEdgeSchema.safeParse({ ...definedIn, kind: 'SECURED_BY' }).success).toBe(
        false,
      );
      expect(mapsToEdgeSchema.safeParse({ ...definedIn, kind: 'MAPS_TO' }).success).toBe(false);
    });

    it('rejects an edge whose ends belong to two tenants (§8.6)', () => {
      expect(
        definedInEdgeSchema.safeParse({
          ...definedIn,
          toKey: `spec_document:${OTHER_TENANT}:${encodeURIComponent('specs/petstore.yaml')}`,
        }).success,
      ).toBe(false);
    });

    it('does not re-define EXPOSES or the endpoint shape', () => {
      expect(endpointNodeSchema.safeParse(endpoint).success).toBe(true);
      expect(SURFACE_EDGE_KINDS.filter((kind) => kind === 'EXPOSES')).toHaveLength(1);
    });
  });
});
