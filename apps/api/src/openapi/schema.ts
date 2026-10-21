import { z } from 'zod';

import {
  ERROR_CODES,
  type ErrorCode,
  PROBLEM_JSON_CONTENT_TYPE,
  problemTypeFor,
} from '@blackwing/errors';

export type JsonObject = Record<string, unknown>;

const COMPONENT_SCHEMAS = '#/components/schemas/';
const DEFS_PREFIX = '#/$defs/';

/** JSON Schema (2020-12, which OpenAPI 3.1 adopts) for a Zod schema, without the `$schema` marker. */
export function jsonSchema(schema: z.ZodType): JsonObject {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io: 'output',
  }) as JsonObject;
  const rest = { ...generated };
  delete rest.$schema;
  return rest;
}

function rewriteRefs(node: unknown, name: string): unknown {
  if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, name));
  if (node === null || typeof node !== 'object') return node;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      if (value === '#') out[key] = `${COMPONENT_SCHEMAS}${name}`;
      else if (value.startsWith(DEFS_PREFIX))
        out[key] = `${COMPONENT_SCHEMAS}${name}.${value.slice(DEFS_PREFIX.length)}`;
      else out[key] = value;
    } else {
      out[key] = rewriteRefs(value, name);
    }
  }
  return out;
}

/**
 * Registers a Zod schema as `components.schemas[name]`. Self references (`$ref: '#'`) and hoisted
 * `$defs` become component refs, so recursive DTOs emit valid, finite `$ref`s.
 */
export function registerSchema(schemas: JsonObject, name: string, schema: z.ZodType): void {
  const { $defs, ...root } = jsonSchema(schema);
  schemas[name] = rewriteRefs(root, name);
  for (const [defName, def] of Object.entries(($defs ?? {}) as JsonObject)) {
    schemas[`${name}.${defName}`] = rewriteRefs(def, name);
  }
}

/** One named `application/problem+json` example per error code. */
export function problemExamples(codes: readonly ErrorCode[]): JsonObject {
  return Object.fromEntries(
    codes.map((code) => [
      code,
      {
        summary: ERROR_CODES[code].title,
        value: {
          type: problemTypeFor(code),
          title: ERROR_CODES[code].title,
          status: ERROR_CODES[code].status,
          code,
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        },
      },
    ]),
  );
}

/** Error responses grouped by status; every one references the shared `Problem` component. */
export function errorResponses(codes: readonly ErrorCode[]): JsonObject {
  const byStatus = new Map<number, ErrorCode[]>();
  for (const code of codes) {
    const status = ERROR_CODES[code].status;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  return Object.fromEntries(
    [...byStatus.entries()].map(([status, list]) => [
      String(status),
      {
        description: `Problem details; code is one of ${list.join(', ')}.`,
        content: {
          [PROBLEM_JSON_CONTENT_TYPE]: {
            schema: { $ref: `${COMPONENT_SCHEMAS}Problem` },
            examples: problemExamples(list),
          },
        },
      },
    ]),
  );
}
