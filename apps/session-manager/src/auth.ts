import { SmTenantMismatchError, SmUnauthenticatedError, type AuthFailureReason } from './errors.js';

import type { Principal, TokenVerifier } from './tokens.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Every `/internal/sessions/*` route requires a valid token, and so does every unmatched path below it. */
export const PROTECTED_PREFIX = '/internal/sessions';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the token hook on `/internal/sessions/*`; `null` everywhere else. */
    principal: Principal | null;
  }
}

/** The tenant (and run, when the route is run-scoped) a handler is about to act for. */
export interface RouteScope {
  readonly tenantId: string;
  readonly runId?: string;
}

/**
 * Authorises one request against the scope it names (S8.6). A run-scoped token reaches only its own run,
 * and only under its own tenant. A control-plane token reaches tenant-level routes only, never a run route.
 * Anything else is a 403 `SM_TENANT_MISMATCH`.
 */
export function assertScope(principal: Principal | null, scope: RouteScope): Principal {
  if (principal === null) throw new SmUnauthenticatedError('missing');
  if (principal.tenantId !== scope.tenantId) throw new SmTenantMismatchError();
  if (scope.runId === undefined) {
    if (principal.kind !== 'control') throw new SmTenantMismatchError();
  } else if (principal.kind !== 'run' || principal.runId !== scope.runId) {
    throw new SmTenantMismatchError();
  }
  return principal;
}

/**
 * True for `/internal/sessions` and everything below it. Deliberately broader than the router: the path is
 * percent-decoded, repeated slashes are collapsed and case is ignored, so no spelling the router might match
 * can slip past. An undecodable path counts as protected (fail closed).
 */
export function isProtectedPath(url: string): boolean {
  const raw = url.split('?', 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return true;
  }
  const path = decoded.replaceAll(/\/+/g, '/').toLowerCase();
  return path === PROTECTED_PREFIX || path.startsWith(`${PROTECTED_PREFIX}/`);
}

export type AuthFailureListener = (request: FastifyRequest, reason: AuthFailureReason) => void;

/**
 * Registers the fail-closed token check. It runs in `onRequest`, before routing and before the body is read,
 * so an unauthenticated caller never gets a body parsed or a handler run.
 */
export function registerTokenAuth(
  app: FastifyInstance,
  verifier: TokenVerifier,
  onFailure?: AuthFailureListener,
): void {
  app.decorateRequest('principal', null);
  app.addHook('onRequest', (request, _reply, done) => {
    if (!isProtectedPath(request.url)) {
      done();
      return;
    }
    try {
      request.principal = verifier.verify(request.headers.authorization);
      done();
    } catch (error) {
      const reason = error instanceof SmUnauthenticatedError ? error.reason : 'malformed';
      onFailure?.(request, reason);
      done(error instanceof SmUnauthenticatedError ? error : new SmUnauthenticatedError(reason));
    }
  });
}
