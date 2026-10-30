import { describe, expect, it } from 'vitest';

import { operationsOf, renderGeneratedFiles, readSpec, PACKAGE_ROOT } from './generate.js';

const spec = (paths: Record<string, Record<string, unknown>>, servers = [{ url: '/v1' }]) => ({
  openapi: '3.1.0',
  info: { title: 't', version: '0' },
  servers,
  paths,
});

const op = (operationId: string, extra: Record<string, unknown> = {}) => ({
  operationId,
  responses: {},
  ...extra,
});

/** Rendering the whole spec twice takes seconds on a loaded machine, past vitest's 5 s default. */
const RENDER_TWICE_TIMEOUT_MS = 30_000;

describe('operationsOf', () => {
  it('emits full paths under the server path and sorts by operationId', () => {
    const found = operationsOf(
      spec({
        '/kill/{id}': {
          get: op('getKillEvent', { parameters: [{ name: 'id', in: 'path', required: true }] }),
        },
        '/kill': {
          post: op('triggerKill', {
            parameters: [{ name: 'Idempotency-Key', in: 'header', required: true }],
          }),
        },
      }),
    );
    expect(found.map((o) => o.operationId)).toEqual(['getKillEvent', 'triggerKill']);
    expect(found[0]).toMatchObject({ method: 'GET', path: '/v1/kill/{id}', pathParams: ['id'] });
    expect(found[1]).toMatchObject({
      method: 'POST',
      path: '/v1/kill',
      requiredHeaders: ['Idempotency-Key'],
    });
  });

  it('records query parameters and ignores optional headers', () => {
    const [found] = operationsOf(
      spec({
        '/items': {
          get: op('listItems', {
            parameters: [
              { name: 'cursor', in: 'query' },
              { name: 'limit', in: 'query' },
              { name: 'X-Optional', in: 'header', required: false },
            ],
          }),
        },
      }),
    );
    expect(found?.queryParams).toEqual(['cursor', 'limit']);
    expect(found?.requiredHeaders).toEqual([]);
  });

  it('refuses a $ref parameter instead of guessing its location', () => {
    expect(() =>
      operationsOf(
        spec({ '/x': { get: op('x', { parameters: [{ $ref: '#/components/parameters/P' }] }) } }),
      ),
    ).toThrow(/\$ref parameters are not supported/);
  });

  it('refuses duplicate operationIds, which would make two methods collide', () => {
    expect(() =>
      operationsOf(spec({ '/a': { get: op('same') }, '/b': { get: op('same') } })),
    ).toThrow(/duplicate operationId same/);
  });

  it('refuses an absolute server URL, which could send credentials elsewhere', () => {
    expect(() =>
      operationsOf(spec({ '/a': { get: op('a') } }, [{ url: 'https://evil.example/v1' }])),
    ).toThrow(/server url must be a path/);
  });

  it('refuses a spec with no operation id', () => {
    expect(() => operationsOf(spec({ '/a': { get: { responses: {} } } }))).toThrow();
  });
});

describe('renderGeneratedFiles', () => {
  it(
    'renders the same bytes twice (deterministic output for the drift check)',
    async () => {
      const first = await renderGeneratedFiles(readSpec());
      const second = await renderGeneratedFiles(readSpec());
      expect(second).toEqual(first);
      expect(first.operations).toContain('getKillEvent');
      expect(first.schema).toContain('export interface operations');
      expect(PACKAGE_ROOT).toMatch(/packages\/api-client\/?$/);
    },
    RENDER_TWICE_TIMEOUT_MS,
  );
});
