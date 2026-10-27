import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { operatorKillOpenApiDocument } from './openapi.js';

/** The committed spec artifact; regenerate by deleting it and running this test. */
const SPEC_FILE = new URL('../../../../docs/api/openapi/operator-kill.v1.json', import.meta.url);
const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

type Json = Record<string, unknown>;
const doc = operatorKillOpenApiDocument();
const at = (value: unknown, ...path: string[]): Json =>
  path.reduce<Json>((node, key) => (node[key] ?? {}) as Json, value as Json);

describe('operator kill OpenAPI 3.1 document', () => {
  it('matches the committed docs/api/openapi/operator-kill.v1.json', () => {
    if (!existsSync(SPEC_FILE)) {
      mkdirSync(new URL('.', SPEC_FILE), { recursive: true });
      writeFileSync(SPEC_FILE, serialise(doc));
    }
    // Compared as data: the committed file is Prettier-formatted.
    expect(JSON.parse(readFileSync(SPEC_FILE, 'utf8'))).toEqual(doc);
  });

  it('lists the four operator endpoints', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(at(doc, 'paths'))).toEqual([
      '/operator/v1/kill/blast-radius',
      '/operator/v1/kill',
      '/operator/v1/kill/events',
      '/operator/v1/kill/events/{id}',
    ]);
  });

  it('documents the operator error codes with examples and requires the Idempotency-Key', () => {
    const post = at(doc, 'paths', '/operator/v1/kill', 'post');
    const responses = at(post, 'responses');
    const examples = Object.values(responses).flatMap((response) =>
      Object.keys(at(response, 'content', 'application/problem+json', 'examples')),
    );
    for (const code of [
      'NOT_OPERATOR',
      'KILL_ALREADY_IN_PROGRESS',
      'KILL_PARTIAL',
      'VALIDATION_FAILED',
    ]) {
      expect(examples).toContain(code);
    }
    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(['202', '403', '409', '422', '424']),
    );
    expect(post.parameters).toEqual([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]);
  });

  it('generates the request schema from Zod (global or tenant only)', () => {
    const request = at(doc, 'components', 'schemas', 'OperatorKillRequest');
    expect(at(request, 'properties', 'scope').enum).toEqual(['global', 'tenant']);
    expect(request.required).toEqual(['scope', 'reason']);
  });
});
