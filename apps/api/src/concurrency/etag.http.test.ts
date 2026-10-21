import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createApiApp } from '../bootstrap/create-app.js';
import { loadApiConfig } from '../config.js';
import { MemoryWidgetRepo, widgetsModule } from './fixtures.test-helpers.js';

import type { HttpMetrics } from '../bootstrap/metrics.js';
import type { Problem } from '@blackwing/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

const repo = new MemoryWidgetRepo(5);
let app: NestFastifyApplication;
let metrics: HttpMetrics;

beforeAll(async () => {
  repo.rows.set('w1', { id: 'w1', name: 'one', state_version: 1 });
  const created = await createApiApp({
    config: loadApiConfig({ NODE_ENV: 'test', WEB_ORIGIN: 'http://localhost:3000' }),
    logger: createLogger('api', { level: 'silent', nodeEnv: 'test' }),
    imports: [widgetsModule(repo)],
  });
  app = created.app;
  metrics = created.metrics;
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

const get = (id = 'w1') => app.inject({ method: 'GET', url: `/v1/widgets/${id}` });
const patch = (headers: Record<string, string>, name = 'renamed', id = 'w1') =>
  app.inject({ method: 'PATCH', url: `/v1/widgets/${id}`, headers, payload: { name } });

describe('ETag / If-Match over HTTP', () => {
  it('GET returns a strong ETag; PATCH with the matching If-Match succeeds and returns the new ETag', async () => {
    const first = await get();
    expect(first.headers.etag).toBe('"v1"');
    const updated = await patch({ 'if-match': String(first.headers.etag) }, 'two');
    expect(updated.statusCode).toBe(200);
    expect(updated.headers.etag).toBe('"v2"');
    expect((await get()).headers.etag).toBe('"v2"');
  });

  it('PATCH without If-Match is 428 precondition_required', async () => {
    const res = await patch({});
    expect(res.statusCode).toBe(428);
    expect(res.json<Problem>().code).toBe('precondition_required');
  });

  it('a weak If-Match is 428', async () => {
    const res = await patch({ 'if-match': 'W/"v2"' });
    expect(res.statusCode).toBe(428);
  });

  it('a stale If-Match is 412 and counts optimistic_conflicts_total', async () => {
    const res = await patch({ 'if-match': '"v1"' });
    expect(res.statusCode).toBe(412);
    expect(res.json<Problem>().code).toBe('precondition_failed');
    expect(await metrics.registry.getSingleMetricAsString('optimistic_conflicts_total')).toMatch(
      /optimistic_conflicts_total\{route="\/v1\/widgets\/:id"\} [1-9]/,
    );
  });

  it('accepts any matching tag in a list and If-Match: * on an existing resource', async () => {
    const current = String((await get()).headers.etag);
    expect((await patch({ 'if-match': `"v99", ${current}` })).statusCode).toBe(200);
    expect((await patch({ 'if-match': '*' })).statusCode).toBe(200);
  });

  it('If-Match: * on a missing resource is 412, and a deleted resource rejects its old tag', async () => {
    expect((await patch({ 'if-match': '*' }, 'x', 'ghost')).statusCode).toBe(412);
    repo.rows.set('w2', { id: 'w2', name: 'two', state_version: 1 });
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/widgets/w2',
      headers: { 'if-match': '"v1"' },
    });
    expect(del.statusCode).toBe(200);
    expect((await patch({ 'if-match': '"v1"' }, 'x', 'w2')).statusCode).toBe(412);
  });

  it('concurrent PATCHes with the same ETag: exactly one wins, the rest get 412', async () => {
    repo.rows.set('race', { id: 'race', name: 'r', state_version: 1 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => patch({ 'if-match': '"v1"' }, `n${String(i)}`, 'race')),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 412)).toHaveLength(7);
    expect(repo.rows.get('race')?.state_version).toBe(2);
  });

  it('leaves error responses without an ETag', async () => {
    expect((await get('ghost')).headers.etag).toBeUndefined();
  });
});
