// Integration: spec ingestion writes through the GRAPH-005 upsert against a real Neo4j 5 (`pnpm test:int`, Docker
// required). These cover idempotent re-ingest, tenant isolation, fail-closed tenant context and the round trip of the
// spec-ingestion kinds through the repository.
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppError } from '@blackwing/errors';
import { type Neo4jHandle, withNeo4j } from '@blackwing/testing/containers';

import { ingestSurfaceArtefact, type IngestSurfaceWritten } from './surface-ingest.js';
import { createGraphRuntime, type GraphRuntime } from '../graph/driver.js';
import { runGraphMigrations } from '../graph/migrate.js';
import {
  SurfaceGraphRepository,
  type SurfaceUpsertAudit,
  withTenantGraph,
} from '../graph/repository.js';

import type { ParsedArtefactInput, SurfaceMapContextInput } from './surface-mapper.js';
import type { Neo4jConfig } from '../graph/config.js';
import type { AuditEventInput } from '@blackwing/audit';
import type { SurfaceNode } from '@blackwing/contracts';

const TENANT_ONE = '018f2a6e-2d00-7000-8000-0000000000e1';
const TENANT_TWO = '018f2a6e-2d00-7000-8000-0000000000e2';
const ASSET = '018f2a6e-2d02-7000-8000-000000000042';
const RUN_ONE = '018f2a6e-2d01-7000-8000-00000000000a';
const RUN_TWO = '018f2a6e-2d01-7000-8000-00000000000b';
const MANIFEST = '018f2a6e-2d03-7000-8000-000000000001';
const SEEN = '2026-10-29T10:00:00.000Z';

let neo: Neo4jHandle;
let runtime: GraphRuntime;
let driver: Driver;

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function configFor(handle: Neo4jHandle): Neo4jConfig {
  return {
    uri: handle.boltUrl,
    username: handle.username,
    password: handle.password,
    database: 'neo4j',
    maxPoolSize: 10,
    connectionTimeoutMs: 5000,
    maxTxRetryMs: 15000,
    upsertBatchSize: 500,
  };
}

function context(tenantId: string, runId: string): SurfaceMapContextInput {
  return {
    tenantId,
    assetId: ASSET,
    runId,
    manifestId: MANIFEST,
    artefactKey: 'specs/petstore.yaml',
    tool: 'openapi-parser',
    confidence: 0.9,
    seenAt: SEEN,
  };
}

const petstore: ParsedArtefactInput = {
  specKind: 'openapi',
  title: 'Petstore',
  version: '1.0.0',
  servers: ['https://api.example.test/v1'],
  authSchemes: [{ name: 'api_key', schemeType: 'apiKey' }],
  schemas: [{ name: 'Pet', type: 'object' }],
  operations: [
    {
      method: 'GET',
      path: '/pets/{petId}',
      contentTypes: ['application/json'],
      authRequired: true,
      security: ['api_key'],
      parameters: [{ name: 'petId', location: 'path', dataType: 'integer' }],
    },
  ],
  routes: [{ file: 'src/routes/pets.ts', handler: 'getPet', method: 'GET', path: '/pets/{petId}' }],
  configItems: [{ key: 'DATABASE_URL', scope: 'env' }],
};

function publisher(): {
  publish: ReturnType<typeof vi.fn<(event: IngestSurfaceWritten) => Promise<void>>>;
} {
  return {
    publish: vi.fn<(event: IngestSurfaceWritten) => Promise<void>>(() => Promise.resolve()),
  };
}

function auditSink(): SurfaceUpsertAudit & { emitAudit: ReturnType<typeof vi.fn> } {
  return { emitAudit: vi.fn<(input: AuditEventInput) => Promise<void>>(() => Promise.resolve()) };
}

/** Runs a read-only count query against the graph and returns it as a plain number. */
async function scalar(cypher: string, params: Record<string, unknown>): Promise<number> {
  const result = await driver.executeQuery(cypher, params, { database: runtime.database });
  const value: unknown = result.records[0]?.get('value');
  return neo4j.isInt(value) ? value.toNumber() : Number(value);
}

beforeAll(async () => {
  neo = await withNeo4j();
  runtime = createGraphRuntime(configFor(neo), { logger: quietLogger });
  driver = runtime.driver;
  await runGraphMigrations(runtime);
}, 180_000);

afterAll(async () => {
  await runtime.driver.close();
  await neo.stop();
});

describe('spec ingestion against Neo4j 5 (INGEST-001)', () => {
  it('writes the spec once, and re-ingesting the same spec creates nothing', async () => {
    const events = publisher();
    const sink = auditSink();
    const options = { graph: { runtime, audit: sink }, events };

    const first = await ingestSurfaceArtefact(petstore, context(TENANT_ONE, RUN_ONE), options);
    expect(first.nodes.created).toBeGreaterThan(0);
    expect(first.edges.created).toBeGreaterThan(0);

    const second = await ingestSurfaceArtefact(petstore, context(TENANT_ONE, RUN_TWO), options);
    expect(second.nodes.created).toBe(0);
    expect(second.edges.created).toBe(0);
    expect(second.nodes.updated).toBeGreaterThan(0);

    expect(
      await scalar('MATCH (n:SpecDocument {tenantId: $tenantId}) RETURN count(n) AS value', {
        tenantId: TENANT_ONE,
      }),
    ).toBe(1);
    expect(
      await scalar('MATCH (n:Endpoint {tenantId: $tenantId}) RETURN count(n) AS value', {
        tenantId: TENANT_ONE,
      }),
    ).toBe(1);
    expect(
      await scalar('MATCH ()-[r:DEFINED_IN {tenantId: $tenantId}]->() RETURN count(r) AS value', {
        tenantId: TENANT_ONE,
      }),
    ).toBe(4);
    expect(sink.emitAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'graph.surface.upserted', tenantId: TENANT_ONE }),
    );
  });

  it('publishes ingest.surface.written with the counts the upsert returned', async () => {
    const events = publisher();
    await ingestSurfaceArtefact(petstore, context(TENANT_ONE, RUN_ONE), {
      graph: { runtime, audit: auditSink() },
      events,
    });
    const [event] = events.publish.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      runId: RUN_ONE,
      tenantId: TENANT_ONE,
      manifestId: MANIFEST,
    });
    expect(event?.byKind.spec_document?.created ?? 0).toBeGreaterThan(0);
    expect(event?.count).toBeGreaterThan(0);
  });

  it('writes nothing for an empty artefact and still publishes ingest.surface.written with count 0', async () => {
    const events = publisher();
    const result = await ingestSurfaceArtefact({}, context(TENANT_TWO, RUN_ONE), {
      graph: { runtime, audit: auditSink() },
      events,
    });
    expect(result.nodes.created + result.nodes.updated).toBe(0);
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ count: 0, byKind: {} }));
    expect(
      await scalar('MATCH (n {tenantId: $tenantId}) RETURN count(n) AS value', {
        tenantId: TENANT_TWO,
      }),
    ).toBe(0);
  });

  it('round-trips the spec-ingestion kinds through the repository', async () => {
    await ingestSurfaceArtefact(petstore, context(TENANT_ONE, RUN_ONE), {
      graph: { runtime, audit: auditSink() },
      events: publisher(),
    });
    const scheme = await withTenantGraph(
      TENANT_ONE,
      (repo) =>
        repo.getNode(
          'auth_scheme',
          `auth_scheme:${TENANT_ONE}:${encodeURIComponent('specs/petstore.yaml')}:api_key`,
        ),
      {
        runtime,
      },
    );
    expect(scheme).toMatchObject({ kind: 'auth_scheme', schemeType: 'apiKey', name: 'api_key' });
    const spec = await withTenantGraph(
      TENANT_ONE,
      (repo) =>
        repo.getNode(
          'spec_document',
          `spec_document:${TENANT_ONE}:${encodeURIComponent('specs/petstore.yaml')}`,
        ),
      {
        runtime,
      },
    );
    expect(spec).toMatchObject({ kind: 'spec_document', specKind: 'openapi', title: 'Petstore' });
  });

  it('refuses a node that belongs to another tenant with GRAPH_TENANT_MISMATCH and writes nothing', async () => {
    const foreign: SurfaceNode = {
      kind: 'config_item',
      tenantId: TENANT_TWO,
      provenance: {
        runId: RUN_ONE,
        persona: 'source-spec-ingestion',
        confidence: 0.9,
        firstSeenAt: SEEN,
        lastSeenAt: SEEN,
        sourceManifestId: MANIFEST,
        sourceArtefactKey: 'env/.env',
      },
      key: 'SECRET_NAME',
      scope: 'env',
    };
    const error = await withTenantGraph(TENANT_ONE, (repo) => repo.upsertNodes([foreign]), {
      runtime,
      audit: auditSink(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('GRAPH_TENANT_MISMATCH');
    expect(
      await scalar('MATCH (n:ConfigItem {tenantId: $tenantId}) RETURN count(n) AS value', {
        tenantId: TENANT_TWO,
      }),
    ).toBe(0);
  });

  it('fails closed with no tenant context: a bare repository write is refused, and so is a bad tenant id', async () => {
    const sink = auditSink();
    const bare = new SurfaceGraphRepository(runtime, { audit: sink });
    const node: SurfaceNode = {
      kind: 'config_item',
      tenantId: TENANT_ONE,
      provenance: {
        runId: RUN_ONE,
        confidence: 0.5,
        firstSeenAt: SEEN,
        lastSeenAt: SEEN,
        sourceArtefactKey: 'env/.env',
      },
      key: 'LOG_LEVEL',
      scope: 'env',
    };
    const refused = await bare.upsertNodes([node]).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((refused as AppError).code).toBe('GRAPH_NO_TENANT_CONTEXT');
    expect(sink.emitAudit).not.toHaveBeenCalled();

    const events = publisher();
    const rejected = await ingestSurfaceArtefact(petstore, context('not-a-tenant', RUN_ONE), {
      graph: { runtime, audit: sink },
      events,
    }).catch((caught: unknown) => caught);
    expect((rejected as AppError).code).toBe('VALIDATION_FAILED');
    expect(events.publish).not.toHaveBeenCalled();
  });
});
