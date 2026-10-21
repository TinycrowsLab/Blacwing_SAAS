import { PROBLEM_JSON_CONTENT_TYPE } from '@blackwing/errors';

import type { JsonObject } from './schema.js';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const PROBLEM_REF = '#/components/schemas/Problem';
const ERROR_STATUS_MIN = 400;

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function resolvePointer(document: JsonObject, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((node, key) => asObject(node)[key], document);
}

function collectRefs(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else collectRefs(value, found);
    }
  }
}

function hasNullable(node: unknown): boolean {
  if (Array.isArray(node)) return node.some((item) => hasNullable(item));
  if (node === null || typeof node !== 'object') return false;
  return Object.entries(node).some(([key, value]) => key === 'nullable' || hasNullable(value));
}

function hasExample(media: JsonObject): boolean {
  return media.example !== undefined || Object.keys(asObject(media.examples)).length > 0;
}

/**
 * Project rules on top of the OpenAPI 3.1 meta-schema validation: stable unique `operationId`s, a
 * `security` requirement, at least one error response referencing `Problem`, an example on every
 * operation, no 3.0-style `nullable`, resolvable `$ref`s and no internal routes. Returns problems.
 */
export function lintOpenApiDocument(document: JsonObject): string[] {
  const problems: string[] = [];
  if (document.openapi !== '3.1.0')
    problems.push(`openapi must be 3.1.0, got ${String(document.openapi)}`);
  if (hasNullable(document)) problems.push('3.0-style `nullable` is not valid in OpenAPI 3.1');

  const seenIds = new Set<string>();
  for (const [path, item] of Object.entries(asObject(document.paths))) {
    if (path.startsWith('/internal'))
      problems.push(`${path}: internal routes must not be published`);
    for (const method of METHODS) {
      const operation = asObject(asObject(item)[method]);
      if (Object.keys(operation).length === 0) continue;
      const label = `${method.toUpperCase()} ${path}`;
      const operationId = operation.operationId;
      if (typeof operationId !== 'string' || operationId === '') {
        problems.push(`${label}: missing operationId`);
      } else if (seenIds.has(operationId)) {
        problems.push(`${label}: duplicate operationId ${operationId}`);
      } else {
        seenIds.add(operationId);
      }
      if (!Array.isArray(operation.security) || operation.security.length === 0) {
        problems.push(`${label}: missing security requirement`);
      }
      const responses = asObject(operation.responses);
      const referencesProblem = Object.entries(responses).some(
        ([status, response]) =>
          Number(status) >= ERROR_STATUS_MIN &&
          asObject(asObject(asObject(response).content)[PROBLEM_JSON_CONTENT_TYPE]).schema !==
            undefined &&
          asObject(asObject(asObject(asObject(response).content)[PROBLEM_JSON_CONTENT_TYPE]).schema)
            .$ref === PROBLEM_REF,
      );
      if (!referencesProblem) problems.push(`${label}: no error response references Problem`);
      const media = [
        ...Object.values(asObject(asObject(operation.requestBody).content)),
        ...Object.entries(responses)
          .filter(([status]) => Number(status) < ERROR_STATUS_MIN)
          .flatMap(([, response]) => Object.values(asObject(asObject(response).content))),
      ].map((item) => asObject(item));
      if (!media.some((item) => hasExample(item)))
        problems.push(`${label}: no request or response example`);
    }
  }

  const refs: string[] = [];
  collectRefs(document, refs);
  for (const ref of new Set(refs)) {
    if (resolvePointer(document, ref) === undefined) problems.push(`unresolved $ref ${ref}`);
  }
  return problems;
}
