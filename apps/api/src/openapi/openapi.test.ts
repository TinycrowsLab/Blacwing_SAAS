import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Validator } from '@seriousme/openapi-schema-validator';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildOpenApiDocument,
  countOperations,
  type OpenApiModule,
  publicOpenApiModules,
} from './document.js';
import { apiPackageVersion, currentOpenApiDocument, emitOpenApi, SPEC_FILE } from './emit.js';
import { lintOpenApiDocument } from './lint.js';
import { type JsonObject, registerSchema } from './schema.js';

type Json = Record<string, unknown>;
const at = (value: unknown, ...keys: string[]): Json =>
  keys.reduce<Json>((node, key) => (node[key] ?? {}) as Json, value as Json);

const doc = currentOpenApiDocument();
const scratch = mkdtempSync(path.join(tmpdir(), 'bw-openapi-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('schema to OpenAPI 3.1 fragment', () => {
  const Status = z.enum(['open', 'closed']);
  const Dto = z.object({
    id: z.uuid(),
    status: Status,
    note: z.string().nullable(),
    tags: z.array(z.string()).optional(),
    owner: z.object({ name: z.string(), email: z.email().optional() }),
  });

  it('represents enum, nested, optional and nullable fields', () => {
    const schemas: JsonObject = {};
    registerSchema(schemas, 'Dto', Dto);
    const dto = schemas.Dto as Json;
    expect(dto.required).toEqual(['id', 'status', 'note', 'owner']);
    expect(at(dto, 'properties', 'status').enum).toEqual(['open', 'closed']);
    expect(at(dto, 'properties', 'owner', 'properties', 'name').type).toBe('string');
    // 3.1 nullability: a type union or anyOf with `null`, never 3.0 `nullable: true`.
    expect(JSON.stringify(dto)).toContain('"null"');
    expect(JSON.stringify(dto)).not.toContain('nullable');
  });

  it('emits finite, resolvable $refs for recursive schemas', () => {
    interface Node {
      name: string;
      children: Node[];
    }
    const NodeSchema: z.ZodType<Node> = z.object({
      name: z.string(),
      get children() {
        return z.array(NodeSchema);
      },
    });
    const schemas: JsonObject = {};
    registerSchema(schemas, 'Tree', NodeSchema);
    const text = JSON.stringify(schemas);
    expect(text).toContain('#/components/schemas/Tree');
    expect(text).not.toContain('"$ref":"#"');
    expect(text).not.toContain('#/$defs');
  });

  it('keeps discriminated unions as oneOf/anyOf with the discriminator property', () => {
    const Shape = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), x: z.number() }),
      z.object({ kind: z.literal('b'), y: z.string() }),
    ]);
    const schemas: JsonObject = {};
    registerSchema(schemas, 'Shape', Shape);
    const shape = schemas.Shape as Json;
    const branches = (shape.oneOf ?? shape.anyOf) as Json[];
    expect(branches).toHaveLength(2);
    expect(branches.map((b) => at(b, 'properties', 'kind').const)).toEqual(['a', 'b']);
  });
});

/** The tag each published operation is filed under (the module that owns its route). */
const TAG_OF_OPERATION: Readonly<Record<string, string>> = {
  triggerKill: 'kill',
  listOncallRosters: 'oncall',
  createOncallRoster: 'oncall',
  getOncallRoster: 'oncall',
  updateOncallRoster: 'oncall',
  getKillEvent: 'kill',
  listKillEvents: 'kill',
  listAuditEvents: 'audit',
  streamRunEvents: 'runs',
  getGate1Plan: 'gate1',
  decideGate1: 'gate1',
  listPersonas: 'personas',
  getPersona: 'personas',
  getPersonaOverride: 'personas',
  putPersonaOverride: 'personas',
  getRunSurface: 'surface',
  requestSignup: 'signup',
  verifySignup: 'signup',
  getTenantSettings: 'tenant',
  updateTenantSettings: 'tenant',
  listAssessmentRequests: 'assessment-requests',
  listAssets: 'assets',
  createAsset: 'assets',
  getAsset: 'assets',
  updateAsset: 'assets',
  deleteAsset: 'assets',
  createAssessmentRequest: 'assessment-requests',
  getAssessmentRequest: 'assessment-requests',
  updateAssessmentRequest: 'assessment-requests',
  submitAssessmentRequest: 'assessment-requests',
  withdrawAssessmentRequest: 'assessment-requests',
  createStandingAuthorisation: 'standing-authorisations',
  listStandingAuthorisations: 'standing-authorisations',
  getStandingAuthorisation: 'standing-authorisations',
  updateStandingAuthorisation: 'standing-authorisations',
  submitStandingAuthorisation: 'standing-authorisations',
  createTestPlanVersion: 'test-plans',
  listTestPlanVersions: 'test-plans',
  getTestPlanVersion: 'test-plans',
  addTestCase: 'test-plans',
  updateTestCase: 'test-plans',
  removeTestCase: 'test-plans',
  approveStandingAuthorisation: 'standing-authorisations',
  rejectStandingAuthorisation: 'standing-authorisations',
  listFindings: 'findings',
  getFinding: 'findings',
  validateTestPlan: 'test-plans',
};

describe('public OpenAPI document', () => {
  it('is 3.1.0 with the package version and the /v1 server', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(at(doc, 'info').version).toBe(apiPackageVersion());
    expect(doc.servers).toEqual([{ url: '/v1' }]);
  });

  it('validates against the OpenAPI 3.1 meta-schema', async () => {
    const result = await new Validator().validate(doc);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  }, 60_000);

  it('passes the project lint', () => {
    expect(lintOpenApiDocument(doc)).toEqual([]);
  });

  it('gives every operation an operationId, a tag and an error response referencing Problem', () => {
    const ids: string[] = [];
    for (const item of Object.values(at(doc, 'paths'))) {
      for (const operation of Object.values(item as Json) as Json[]) {
        ids.push(operation.operationId as string);
        expect(operation.tags).toEqual([TAG_OF_OPERATION[operation.operationId as string]]);
        const refs = Object.entries(operation.responses as Json)
          .filter(([status]) => Number(status) >= 400)
          .map(([, r]) => at(r, 'content', 'application/problem+json', 'schema').$ref);
        expect(refs.length).toBeGreaterThan(0);
        expect(new Set(refs)).toEqual(new Set(['#/components/schemas/Problem']));
      }
    }
    expect(ids.sort()).toEqual([
      'addTestCase',
      'approveStandingAuthorisation',
      'createAssessmentRequest',
      'createAsset',
      'createOncallRoster',
      'createStandingAuthorisation',
      'createTestPlanVersion',
      'decideGate1',
      'deleteAsset',
      'getAssessmentRequest',
      'getAsset',
      'getFinding',
      'getGate1Plan',
      'getKillEvent',
      'getOncallRoster',
      'getPersona',
      'getPersonaOverride',
      'getRunSurface',
      'getStandingAuthorisation',
      'getTenantSettings',
      'getTestPlanVersion',
      'listAssessmentRequests',
      'listAssets',
      'listAuditEvents',
      'listFindings',
      'listKillEvents',
      'listOncallRosters',
      'listPersonas',
      'listStandingAuthorisations',
      'listTestPlanVersions',
      'putPersonaOverride',
      'rejectStandingAuthorisation',
      'removeTestCase',
      'requestSignup',
      'streamRunEvents',
      'submitAssessmentRequest',
      'submitStandingAuthorisation',
      'triggerKill',
      'updateAssessmentRequest',
      'updateAsset',
      'updateOncallRoster',
      'updateStandingAuthorisation',
      'updateTenantSettings',
      'updateTestCase',
      'validateTestPlan',
      'verifySignup',
      'withdrawAssessmentRequest',
    ]);
    expect(countOperations(doc)).toBe(47);
  });

  it('declares the standard error statuses and the common parameters', () => {
    const responses = at(doc, 'paths', '/kill', 'post', 'responses');
    for (const status of ['400', '401', '403', '404', '409', '422', '429']) {
      expect(responses).toHaveProperty(status);
    }
    const parameters = at(doc, 'components', 'parameters');
    expect(Object.keys(parameters)).toEqual(['Cursor', 'Limit', 'IdempotencyKey', 'IfMatch']);
    expect(at(doc, 'components', 'headers')).toHaveProperty('ETag');
    expect(at(parameters, 'Limit', 'schema').maximum).toBe(200);
  });

  it('adds 412 and 428 only to operations that take If-Match', () => {
    const module: OpenApiModule = {
      tag: 'thing',
      description: 'things',
      schemas: {},
      paths: {
        '/v1/things/{id}': {
          patch: {
            operationId: 'updateThing',
            security: [{ bearerAuth: [] }],
            parameters: [{ $ref: '#/components/parameters/IfMatch' }],
            requestBody: { content: { 'application/json': { schema: {}, example: {} } } },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const built = buildOpenApiDocument({ version: '1.0.0', modules: [module] });
    const responses = at(built, 'paths', '/things/{id}', 'patch', 'responses');
    expect(responses).toHaveProperty('412');
    expect(responses).toHaveProperty('428');
    expect(at(doc, 'paths', '/kill', 'post', 'responses')).not.toHaveProperty('412');
  });

  it('never publishes internal broker routes', () => {
    expect(JSON.stringify(Object.keys(at(doc, 'paths')))).not.toContain('internal');
    const leaky: OpenApiModule = {
      tag: 'broker',
      description: 'internal',
      schemas: {},
      paths: { '/internal/broker/journal': { post: { operationId: 'x', responses: {} } } },
    };
    expect(() => buildOpenApiDocument({ version: '1.0.0', modules: [leaky] })).toThrow(/internal/);
  });

  it('contains no secrets in examples (placeholders only)', () => {
    expect(JSON.stringify(doc)).not.toMatch(/bw_(pat|ci)_[A-Za-z0-9]{8,}/);
  });

  it('exposes every module from publicOpenApiModules', () => {
    expect(publicOpenApiModules().map((m) => m.tag)).toEqual([
      'kill',
      'audit',
      'runs',
      'surface',
      'gate1',
      'personas',
      'signup',
      'tenant',
      'assessment-requests',
      'assets',
      'standing-authorisations',
      'test-plans',
      'findings',
      'oncall',
    ]);
  });
});

describe('lint rules', () => {
  const base = (): Json => structuredClone<Json>(doc);

  it('flags an operation without operationId', () => {
    const broken = base();
    delete at(broken, 'paths', '/kill', 'post').operationId;
    expect(lintOpenApiDocument(broken)).toContain('POST /kill: missing operationId');
  });

  it('flags an operation without an example', () => {
    const broken = base();
    const get = at(broken, 'paths', '/kill/{id}', 'get');
    get.responses = { ...(get.responses as Json), '200': { description: 'no content' } };
    expect(lintOpenApiDocument(broken)).toContain('GET /kill/{id}: no request or response example');
  });

  it('flags an operation whose errors do not reference Problem', () => {
    const broken = base();
    const get = at(broken, 'paths', '/kill/{id}', 'get');
    get.responses = { '200': (get.responses as Json)['200'] };
    expect(lintOpenApiDocument(broken)).toContain(
      'GET /kill/{id}: no error response references Problem',
    );
  });

  it('flags unresolved refs, 3.0 nullable and duplicate operationIds', () => {
    const broken = base();
    at(broken, 'components', 'schemas').Bad = {
      $ref: '#/components/schemas/Missing',
      nullable: true,
    };
    at(broken, 'paths', '/kill/{id}', 'get').operationId = 'triggerKill';
    const problems = lintOpenApiDocument(broken);
    expect(problems).toContain('unresolved $ref #/components/schemas/Missing');
    expect(problems.some((p) => p.includes('nullable'))).toBe(true);
    expect(problems.some((p) => p.includes('duplicate operationId'))).toBe(true);
  });
});

describe('docs/api/openapi.json drift check', () => {
  it('the committed spec matches the generated document', () => {
    expect(emitOpenApi({ mode: 'check' }).stale).toBe(false);
    expect(JSON.parse(readFileSync(SPEC_FILE, 'utf8'))).toEqual(doc);
  });

  it('reports a spec that no longer matches the DTOs as stale, and emit repairs it', () => {
    const file = pathToFileURL(path.join(scratch, 'openapi.json'));
    expect(emitOpenApi({ mode: 'check', file }).stale).toBe(true); // missing
    emitOpenApi({ mode: 'emit', file });
    expect(emitOpenApi({ mode: 'check', file }).stale).toBe(false);
    const stale = JSON.parse(readFileSync(file, 'utf8')) as Json;
    delete at(stale, 'components', 'schemas').KillTriggerRequest;
    writeFileSync(file, JSON.stringify(stale));
    expect(emitOpenApi({ mode: 'check', file }).stale).toBe(true);
    const result = emitOpenApi({ mode: 'emit', file });
    expect(result.operations).toBe(47);
    expect(emitOpenApi({ mode: 'check', file }).stale).toBe(false);
  });
});
