import { assertScope } from './auth.js';

import type { FastifyPluginCallback } from 'fastify';

interface TenantParams {
  readonly tenantId: string;
}

interface RunParams extends TenantParams {
  readonly runId: string;
}

/**
 * Scope probes under `/internal/sessions`. A control-plane token answers for its tenant; a run-scoped token
 * answers for its own run. Session operations (store, recipes, injection) are added by SESSION-004..012 and
 * call {@link assertScope} first, so no route can skip the check. A refusal is a typed AppError (403 or 401).
 */
export const internalSessionRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get<{ Params: TenantParams }>('/tenants/:tenantId/scope', (request, reply) => {
    assertScope(request.principal, { tenantId: request.params.tenantId });
    return reply.send({ tenantId: request.params.tenantId, kind: request.principal?.kind });
  });

  app.get<{ Params: RunParams }>('/tenants/:tenantId/runs/:runId/scope', (request, reply) => {
    assertScope(request.principal, {
      tenantId: request.params.tenantId,
      runId: request.params.runId,
    });
    return reply.send({
      tenantId: request.params.tenantId,
      runId: request.params.runId,
      kind: request.principal?.kind,
    });
  });
  done();
};
