import { describe, expect, it } from 'vitest';

import {
  SECRET_CREATE_ERROR_CODES,
  SECRET_DELETE_ERROR_CODES,
  secretsOpenApiModule,
} from './openapi.js';
import { currentOpenApiDocument } from '../openapi/emit.js';
import { lintOpenApiDocument } from '../openapi/lint.js';

type Json = Record<string, unknown>;
const at = (value: unknown, ...path: string[]): Json =>
  path.reduce<Json>((node, key) => (node[key] ?? {}) as Json, value as Json);

const doc = currentOpenApiDocument();
const FORBIDDEN_FIELDS = ['value', 'envelope', 'ciphertext', 'wrappedDek'];

describe('secrets API in the public OpenAPI document', () => {
  it('lists every operation, under the secrets tag, and passes the project lint', () => {
    expect(lintOpenApiDocument(doc)).toEqual([]);
    expect(Object.keys(at(doc, 'paths')).filter((p) => p.startsWith('/secrets'))).toEqual([
      '/secrets',
      '/secrets/{id}',
    ]);
    const operations = [
      ['/secrets', 'post', 'createSecret'],
      ['/secrets', 'get', 'listSecrets'],
      ['/secrets/{id}', 'get', 'getSecret'],
      ['/secrets/{id}', 'put', 'updateSecret'],
      ['/secrets/{id}', 'delete', 'deleteSecret'],
    ] as const;
    for (const [path, method, operationId] of operations) {
      const operation = at(doc, 'paths', path, method);
      expect(operation.operationId).toBe(operationId);
      expect(operation.tags).toEqual(['secrets']);
    }
  });

  it('documents the requirement error codes with examples', () => {
    const create = at(doc, 'paths', '/secrets', 'post', 'responses');
    const examples = Object.values(create).flatMap((response) =>
      Object.keys(at(response, 'content', 'application/problem+json', 'examples')),
    );
    for (const code of [
      ...SECRET_CREATE_ERROR_CODES,
      'FORBIDDEN',
      'SECRET_NAME_CONFLICT',
      'SECRET_TOO_LARGE',
    ]) {
      expect(examples).toContain(code);
    }
    expect(Object.keys(create)).toEqual(
      expect.arrayContaining(['201', '400', '401', '403', '409', '413', '422', '503']),
    );
    const remove = at(doc, 'paths', '/secrets/{id}', 'delete', 'responses');
    const removeExamples = Object.values(remove).flatMap((response) =>
      Object.keys(at(response, 'content', 'application/problem+json', 'examples')),
    );
    for (const code of SECRET_DELETE_ERROR_CODES) expect(removeExamples).toContain(code);
    const put = at(doc, 'paths', '/secrets/{id}', 'put', 'responses');
    expect(Object.keys(put)).toEqual(expect.arrayContaining(['200', '404', '412', '428']));
  });

  it('requires Idempotency-Key on create and makes If-Match optional on update', () => {
    const post = at(doc, 'paths', '/secrets', 'post');
    expect(post.parameters).toEqual([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]);
    const put = at(doc, 'paths', '/secrets/{id}', 'put');
    expect(put.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'If-Match', in: 'header', required: false }),
      ]),
    );
  });

  it('keeps value and envelope out of every response schema (only the requests carry a value)', () => {
    const schemas = at(doc, 'components', 'schemas');
    for (const name of ['SecretWriteResponse', 'SecretMetadata', 'SecretMetadataPage']) {
      const text = JSON.stringify(schemas[name]);
      for (const field of FORBIDDEN_FIELDS) expect(text).not.toContain(`"${field}"`);
    }
    expect(at(schemas, 'SecretMetadata').additionalProperties).toBe(false);
    expect(at(schemas, 'SecretWriteResponse').additionalProperties).toBe(false);
    expect(Object.keys(at(schemas, 'CreateSecretRequest', 'properties')).sort()).toEqual(
      ['backend', 'name', 'purpose', 'type', 'value'].sort(),
    );
    expect(at(schemas, 'CreateSecretRequest').additionalProperties).toBe(false);
    expect(Object.keys(at(schemas, 'UpdateSecretRequest', 'properties'))).toEqual(['value']);
  });

  it('never gives a success example a value or an envelope', () => {
    /** Every key at any depth of an example payload. */
    const keysOf = (node: unknown): string[] =>
      node !== null && typeof node === 'object'
        ? Object.entries(node).flatMap(([key, child]) => [key, ...keysOf(child)])
        : [];
    const module = secretsOpenApiModule();
    let checked = 0;
    for (const [path, item] of Object.entries(module.paths)) {
      for (const [method, operation] of Object.entries(item as Json)) {
        for (const [status, response] of Object.entries(at(operation, 'responses'))) {
          if (Number(status) >= 400) continue;
          for (const media of Object.values(at(response, 'content'))) {
            for (const example of Object.values(at(media, 'examples'))) {
              checked += 1;
              expect(keysOf((example as Json).value), `${method} ${path} ${status}`).not.toEqual(
                expect.arrayContaining(['value']),
              );
              expect(keysOf((example as Json).value)).not.toContain('envelope');
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5);
  });
});
