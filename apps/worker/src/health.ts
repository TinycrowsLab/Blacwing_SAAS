import Fastify, { type FastifyInstance } from 'fastify';

import type { HealthReport } from './runtime.js';

const HTTP_OK = 200;
const HTTP_UNAVAILABLE = 503;

/**
 * Builds the health server (not yet listening). `GET /healthz` answers 200 while every worker is polling
 * and 503 otherwise, with each task queue's worker state. It reports no tenant data or configuration.
 */
export function createHealthServer(report: () => HealthReport): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/healthz', async (_request, reply) => {
    const body = report();
    await reply.code(body.status === 'ok' ? HTTP_OK : HTTP_UNAVAILABLE).send(body);
  });
  return app;
}
