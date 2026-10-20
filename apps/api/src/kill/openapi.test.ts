import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { killOpenApiDocument } from './openapi.js';

/** The committed spec artifact; regenerate by deleting it and running this test. */
const SPEC_FILE = new URL('../../../../docs/api/openapi/kill.v1.json', import.meta.url);
const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

type Json = Record<string, unknown>;
const doc = killOpenApiDocument();
const at = (value: unknown, ...path: string[]): Json =>
  path.reduce<Json>((node, key) => (node[key] ?? {}) as Json, value as Json);

describe('kill API OpenAPI 3.1 document', () => {
  it('matches the committed docs/api/openapi/kill.v1.json', () => {
    if (!existsSync(SPEC_FILE)) {
      mkdirSync(new URL('.', SPEC_FILE), { recursive: true });
      writeFileSync(SPEC_FILE, serialise(doc));
    }
    // Compared as data: the committed file is Prettier-formatted.
    expect(JSON.parse(readFileSync(SPEC_FILE, 'utf8'))).toEqual(doc);
  });

  it('is OpenAPI 3.1 and lists both endpoints', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(at(doc, 'paths'))).toEqual(['/v1/kill', '/v1/kill/{id}']);
  });

  it('documents every requirement-6 error code with an example', () => {
    const responses = at(doc, 'paths', '/v1/kill', 'post', 'responses');
    const examples = Object.values(responses).flatMap((response) =>
      Object.keys(at(response, 'content', 'application/problem+json', 'examples')),
    );
    for (const code of [
      'KILL_SCOPE_INVALID',
      'KILL_REF_REQUIRED',
      'KILL_FORBIDDEN',
      'KILL_GLOBAL_NOT_ALLOWED_HERE',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_MISMATCH',
      'UNAUTHENTICATED',
      'VALIDATION_FAILED',
    ]) {
      expect(examples).toContain(code);
    }
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(['202', '400', '401', '403', '404', '422', '500']),
    );
  });

  it('requires the Idempotency-Key header and carries request and response examples', () => {
    const post = at(doc, 'paths', '/v1/kill', 'post');
    expect(post.parameters).toEqual([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]);
    expect(Object.keys(at(post, 'requestBody', 'content', 'application/json', 'examples'))).toEqual(
      ['run', 'asset', 'tenant'],
    );
    expect(at(post, 'responses', '202', 'headers')).toHaveProperty('Location');
  });

  it('generates the request schema from Zod (scope enum excludes global)', () => {
    const request = at(doc, 'components', 'schemas', 'KillTriggerRequest');
    expect(at(request, 'properties', 'scope').enum).toEqual(['run', 'asset', 'tenant']);
    expect(request.required).toEqual(['scope', 'reason']);
    expect(at(doc, 'components', 'schemas', 'KillEvent', 'properties')).toHaveProperty(
      'killEventId',
    );
  });
});
