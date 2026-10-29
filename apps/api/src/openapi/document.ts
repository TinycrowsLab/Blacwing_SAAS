import { idempotencyKeySchema, problemSchema } from '@blackwing/contracts';
import { ERROR_CODES, type ErrorCode } from '@blackwing/errors';

import { errorResponses, type JsonObject, jsonSchema, type OpenApiModule } from './schema.js';
import { auditOpenApiPaths, auditOpenApiSchemas } from '../audit-query/openapi.js';
import { gate1OpenApiModule } from '../gate1/openapi.js';
import { killOpenApiDocument } from '../kill/openapi.js';
import { personaOpenApiModule } from '../personas/openapi.js';
import { runEventsOpenApiModule } from '../run-events/openapi.js';
import { signupOpenApiModule } from '../signup/openapi.js';
import { tenantSettingsOpenApiModule } from '../tenant-settings/openapi.js';

/** Largest page a client may request (§9). */
export const PAGE_LIMIT_MAX = 200;
export const PAGE_LIMIT_DEFAULT = 50;

const API_PREFIX = '/v1';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
/** Paths under these prefixes are never part of the public spec (the sandbox-only Run Broker API). */
const INTERNAL_PATH_PREFIXES = ['/internal'] as const;

/** A feature module's contribution to the public API document (defined in `schema.ts`, so feature modules never import the builder). */
export type { OpenApiModule };

/** The kill trigger API (KILL-003) as a module of the combined document. */
export function killOpenApiModule(): OpenApiModule {
  const source = killOpenApiDocument();
  const schemas = Object.fromEntries(
    Object.entries((source.components as { schemas: JsonObject }).schemas).filter(
      ([name]) => name !== 'Problem',
    ),
  );
  return {
    tag: 'kill',
    description: 'Kill switch: stop every agent in a run, asset or tenant scope.',
    paths: source.paths as JsonObject,
    schemas,
  };
}

/** The audit query API (#86) as a module of the combined document. */
function auditOpenApiModule(): OpenApiModule {
  return {
    tag: 'audit',
    description: 'Audit ledger search: read-only, tenant-scoped, cursor-paginated (F34, §8.8).',
    paths: auditOpenApiPaths(),
    schemas: auditOpenApiSchemas(),
  };
}

/** Every module published in the public spec. Internal routers (`/internal/broker`) are deliberately absent. */
export function publicOpenApiModules(): readonly OpenApiModule[] {
  return [
    killOpenApiModule(),
    auditOpenApiModule(),
    runEventsOpenApiModule(),
    gate1OpenApiModule(),
    personaOpenApiModule(),
    signupOpenApiModule(),
    tenantSettingsOpenApiModule(),
  ];
}

function commonParameters(): JsonObject {
  return {
    Cursor: {
      name: 'cursor',
      in: 'query',
      required: false,
      description: 'Opaque cursor from the previous page `nextCursor`.',
      schema: { type: 'string', minLength: 1, maxLength: 512 },
      example: 'eyJpZCI6IjAxODkwYTVkIn0',
    },
    Limit: {
      name: 'limit',
      in: 'query',
      required: false,
      description: `Page size, 1 to ${PAGE_LIMIT_MAX}.`,
      schema: { type: 'integer', minimum: 1, maximum: PAGE_LIMIT_MAX, default: PAGE_LIMIT_DEFAULT },
      example: 50,
    },
    IdempotencyKey: {
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description:
        'Required on POSTs that create runs, exports or tickets; replays return the first result.',
      schema: jsonSchema(idempotencyKeySchema),
      example: 'run-7f3c2a9e-1',
    },
    IfMatch: {
      name: 'If-Match',
      in: 'header',
      required: true,
      description:
        'The ETag of the version being changed; a stale value answers 412, a missing one 428.',
      schema: { type: 'string', minLength: 1 },
      example: '"3"',
    },
  };
}

/** Statuses every operation documents (§9, API-003); 412/428 only where `If-Match` applies. */
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_UNPROCESSABLE = 422;
const HTTP_TOO_MANY_REQUESTS = 429;
const STANDARD_ERROR_STATUSES = [
  HTTP_BAD_REQUEST,
  HTTP_UNAUTHORIZED,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_CONFLICT,
  HTTP_UNPROCESSABLE,
  HTTP_TOO_MANY_REQUESTS,
] as const;
const HTTP_PRECONDITION_REQUIRED = 428;
const CONCURRENCY_ERROR_STATUSES = [HTTP_PRECONDITION_FAILED, HTTP_PRECONDITION_REQUIRED] as const;

function withStandardErrors(operation: JsonObject): JsonObject {
  const parameters = (operation.parameters ?? []) as JsonObject[];
  const takesIfMatch = parameters.some(
    (p) => p.name === 'If-Match' || p.$ref === '#/components/parameters/IfMatch',
  );
  const wanted: readonly number[] = takesIfMatch
    ? [...STANDARD_ERROR_STATUSES, ...CONCURRENCY_ERROR_STATUSES]
    : STANDARD_ERROR_STATUSES;
  const existing = (operation.responses ?? {}) as JsonObject;
  const codes = (Object.keys(ERROR_CODES) as ErrorCode[]).filter(
    (code) =>
      wanted.includes(ERROR_CODES[code].status) &&
      existing[String(ERROR_CODES[code].status)] === undefined,
  );
  const generated: JsonObject = errorResponses(codes);
  return { ...operation, responses: sortedKeys({ ...existing, ...generated }) };
}

function sortedKeys(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

function publicPath(path: string): string {
  if (INTERNAL_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`internal path ${path} must not be published in the public OpenAPI document`);
  }
  if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) {
    throw new Error(`public path ${path} is not under ${API_PREFIX}`);
  }
  return path.slice(API_PREFIX.length) || '/';
}

/**
 * The public OpenAPI 3.1 document: every module's operations (tagged by module, relative to the `/v1`
 * server), the shared `Problem` schema, the common parameters and the security schemes.
 */
export function buildOpenApiDocument(options: {
  readonly version: string;
  readonly modules?: readonly OpenApiModule[];
}): JsonObject {
  const modules = options.modules ?? publicOpenApiModules();
  const paths: JsonObject = {};
  const schemas: JsonObject = { Problem: jsonSchema(problemSchema) };
  for (const module of modules) {
    for (const [path, item] of Object.entries(module.paths)) {
      const relative = publicPath(path);
      if (paths[relative] !== undefined) throw new Error(`duplicate path ${relative}`);
      const tagged: JsonObject = { ...(item as JsonObject) };
      for (const method of HTTP_METHODS) {
        const operation = tagged[method] as JsonObject | undefined;
        if (operation !== undefined)
          tagged[method] = withStandardErrors({ tags: [module.tag], ...operation });
      }
      paths[relative] = tagged;
    }
    for (const [name, schema] of Object.entries(module.schemas)) {
      if (name in schemas) throw new Error(`duplicate schema ${name}`);
      schemas[name] = schema;
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Blackwing control-plane API',
      version: options.version,
      description:
        'REST API of the Blackwing control plane. Errors are RFC 9457 problem+json (`Problem`).',
    },
    servers: [{ url: API_PREFIX }],
    tags: modules.map((m) => ({ name: m.tag, description: m.description })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Personal access token (bw_pat_...) or CI token (bw_ci_...).',
        },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Host-bw_session' },
      },
      parameters: commonParameters(),
      headers: {
        ETag: {
          description: 'Version of the resource, to send back in If-Match.',
          schema: { type: 'string' },
          example: '"3"',
        },
      },
      schemas: sortedKeys(schemas),
    },
  };
}

/** Number of operations in a document (the `openapi_operations_total` gauge). */
export function countOperations(document: JsonObject): number {
  return Object.values((document.paths ?? {}) as JsonObject).reduce<number>(
    (total, item) =>
      total + HTTP_METHODS.filter((m) => (item as JsonObject)[m] !== undefined).length,
    0,
  );
}

export function countSchemas(document: JsonObject): number {
  return Object.keys((document.components as JsonObject | undefined)?.schemas ?? {}).length;
}
