import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthError, type ErrorEnvironment } from '@blackwing/errors';

import { type DocsAuthenticator, registerDocsRoutes } from './docs-routes.js';
import { currentOpenApiDocument } from './emit.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(environment: ErrorEnvironment, authenticate?: DocsAuthenticator) {
  app = Fastify();
  registerDocsRoutes(app, {
    document: currentOpenApiDocument(),
    environment,
    ...(authenticate === undefined ? {} : { authenticate }),
  });
  await app.ready();
  return app;
}

describe('GET /v1/docs', () => {
  it('renders the UI and lists a sample endpoint with examples outside production', async () => {
    const server = await build('development');
    const page = await server.inject({ method: 'GET', url: '/v1/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('swagger-ui');

    const spec = await server.inject({ method: 'GET', url: '/v1/docs/openapi.json' });
    expect(spec.statusCode).toBe(200);
    const body = spec.json<{ openapi: string; paths: Record<string, { post?: unknown }> }>();
    expect(body.openapi).toBe('3.1.0');
    expect(Object.keys(body.paths)).toContain('/kill');
    expect(spec.body).toContain('"examples"');

    for (const asset of ['init.js', 'swagger-ui.css', 'swagger-ui-bundle.js']) {
      const response = await server.inject({ method: 'GET', url: `/v1/docs/${asset}` });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.length).toBeGreaterThan(0);
    }
  });

  it('answers 401 problem+json in production without an authenticator (fail closed)', async () => {
    const server = await build('production');
    for (const url of ['/v1/docs', '/v1/docs/openapi.json', '/v1/docs/swagger-ui-bundle.js']) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json<{ code: string }>().code).toBe('UNAUTHENTICATED');
    }
  });

  it('answers 401 in production when the credential is rejected', async () => {
    const server = await build('production', () => Promise.reject(new AuthError('expired token')));
    const response = await server.inject({ method: 'GET', url: '/v1/docs' });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('swagger-ui');
  });

  it('serves authenticated callers in production', async () => {
    const server = await build('production', () => Promise.resolve({ sub: 'u1' }));
    const response = await server.inject({ method: 'GET', url: '/v1/docs' });
    expect(response.statusCode).toBe(200);
  });
});
