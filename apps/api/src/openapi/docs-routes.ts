import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { trace } from '@opentelemetry/api';

import {
  AuthError,
  createProblemDetailsMapper,
  type ErrorEnvironment,
  type ProblemDetailsMapper,
} from '@blackwing/errors';

import type { JsonObject } from './schema.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const DOCS_ROUTE = '/v1/docs';
export const DOCS_SPEC_ROUTE = `${DOCS_ROUTE}/openapi.json`;

/** W3C trace ids are 16 random bytes. */
const TRACE_ID_BYTES = 16;

/**
 * Verifies the caller's session or token (§9); it must throw an `AuthError` for a missing, expired or
 * revoked credential. The platform guard (#53/#341) supplies the real one.
 */
export type DocsAuthenticator = (request: FastifyRequest) => Promise<unknown>;

export interface DocsRoutesOptions {
  readonly document: JsonObject;
  readonly environment: ErrorEnvironment;
  /**
   * Required to view the docs in `production`. Without one, production fails closed: every docs request
   * answers 401. Other environments serve the docs publicly.
   */
  readonly authenticate?: DocsAuthenticator;
  readonly problems?: ProblemDetailsMapper;
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Blackwing API reference</title>
    <link rel="stylesheet" href="${DOCS_ROUTE}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${DOCS_ROUTE}/swagger-ui-bundle.js"></script>
    <script src="${DOCS_ROUTE}/init.js"></script>
  </body>
</html>
`;

const INIT_SCRIPT = `window.ui = SwaggerUIBundle({
  url: '${DOCS_SPEC_ROUTE}',
  dom_id: '#swagger-ui',
  deepLinking: true,
});
`;

const swaggerUiDir = (): string =>
  path.dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));

/**
 * Mounts the interactive API reference (Swagger UI, self-hosted so it works offline and under the
 * default CSP) at `/v1/docs`, with the spec at `/v1/docs/openapi.json`. In `production` every route
 * requires an authenticated caller and fails closed (401) when none can be verified.
 */
export function registerDocsRoutes(app: FastifyInstance, options: DocsRoutesOptions): void {
  const problems =
    options.problems ?? createProblemDetailsMapper({ environment: options.environment });
  const dir = swaggerUiDir();
  const assets = new Map<string, { type: string; body: Buffer }>();
  const asset = (file: string, type: string): { type: string; body: Buffer } => {
    const cached = assets.get(file);
    if (cached !== undefined) return cached;
    const loaded = { type, body: readFileSync(path.join(dir, file)) };
    assets.set(file, loaded);
    return loaded;
  };

  void app.register((scope, _opts, done) => {
    scope.setErrorHandler((error: unknown, _request, reply) => {
      const traceId =
        trace.getActiveSpan()?.spanContext().traceId ?? randomBytes(TRACE_ID_BYTES).toString('hex');
      const response = problems.toProblemResponse(error, traceId);
      void reply
        .status(response.status)
        .headers({ ...response.headers })
        .send(response.body);
    });

    scope.addHook('preHandler', async (request) => {
      if (options.environment !== 'production') return;
      if (options.authenticate === undefined) throw new AuthError('authentication required');
      await options.authenticate(request);
    });

    scope.get(DOCS_ROUTE, async (_request, reply) =>
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(PAGE),
    );
    scope.get(DOCS_SPEC_ROUTE, async (_request, reply) =>
      reply.type('application/json').header('cache-control', 'no-store').send(options.document),
    );
    scope.get(`${DOCS_ROUTE}/init.js`, async (_request, reply) =>
      reply.type('text/javascript; charset=utf-8').send(INIT_SCRIPT),
    );
    for (const [file, type] of [
      ['swagger-ui.css', 'text/css; charset=utf-8'],
      ['swagger-ui-bundle.js', 'text/javascript; charset=utf-8'],
    ] as const) {
      scope.get(`${DOCS_ROUTE}/${file}`, async (_request, reply) => {
        const loaded = asset(file, type);
        return reply.type(loaded.type).send(loaded.body);
      });
    }
    done();
  });
}
