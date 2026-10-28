// Programmatic session revocation (#336): ends every BFF session of a user, of a tenant, or of a user in
// one tenant, then asks Keycloak to end the user's own sessions. Used when a user is disabled, a tenant is
// suspended or deleted (TENANT-007), or an admin revokes sessions. The BFF side is authoritative and is
// applied first: a revoked session cannot be read, refreshed or used, whatever Keycloak answers. The
// Keycloak side is retried, and its outcome is reported so the caller can act on a `failed` one.

import type { AuthMetrics } from './metrics.js';
import type { AuthAuditEvent } from './service.js';
import type { SessionIndex, SessionRecord, SessionStore } from './session-store.js';
import type { Logger } from '@blackwing/logger';

const KEYCLOAK_ATTEMPTS = 3;
const KEYCLOAK_BACKOFF_MS = 200;

/** Why the sessions end; a stable code that reaches the audit ledger. */
type RevocationReason = 'admin_revoked' | 'user_disabled' | 'tenant_suspended';

/** At least one of `userId` and `tenantId`: a whole tenant, a user across tenants, or a user in one tenant. */
type RevokeSessionsTarget =
  | { readonly userId: string; readonly tenantId?: string }
  | { readonly userId?: undefined; readonly tenantId: string };

type RevokeSessionsInput = RevokeSessionsTarget & { readonly reason: RevocationReason };

/** `done`: Keycloak confirmed; `skipped`: no Keycloak admin client is configured; `failed`: retries exhausted. */
type IdpLogoutOutcome = 'done' | 'skipped' | 'failed';

interface RevocationResult {
  /** BFF sessions ended on this side. */
  readonly sessions: number;
  readonly idpLogout: IdpLogoutOutcome;
}

/** Ends a user's Keycloak sessions (the Admin API `logout` call). */
export interface IdpSessionLogout {
  logoutUser(sub: string): Promise<void>;
}

export interface SessionRevoker {
  revokeSessions(input: RevokeSessionsInput): Promise<RevocationResult>;
}

export interface SessionRevokerDeps {
  readonly store: SessionStore;
  readonly metrics: Pick<AuthMetrics, 'sessionRevocation'>;
  readonly audit: (event: AuthAuditEvent) => void;
  /** Absent when no Keycloak admin client is configured; the outcome is then `skipped`. */
  readonly idp?: IdpSessionLogout | undefined;
  readonly logger: Pick<Logger, 'warn'>;
  readonly sleep: (ms: number) => Promise<void>;
}

export function createSessionRevoker(deps: SessionRevokerDeps): SessionRevoker {
  const { store, metrics, audit, logger } = deps;

  async function logoutKeycloak(subject: string): Promise<boolean> {
    if (deps.idp === undefined) return true;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await deps.idp.logoutUser(subject);
        return true;
      } catch (error) {
        if (attempt >= KEYCLOAK_ATTEMPTS) {
          logger.warn(
            {
              event: 'auth.idp_logout_failed',
              userId: subject,
              attempts: attempt,
              errorType: error instanceof Error ? error.name : typeof error,
            },
            'keycloak session logout failed',
          );
          return false;
        }
        await deps.sleep(KEYCLOAK_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
  }

  return {
    async revokeSessions(input) {
      const { userId, tenantId, reason } = input;
      const index: SessionIndex =
        input.userId === undefined
          ? { kind: 'tenant', tenantId: input.tenantId }
          : { kind: 'user', sub: input.userId };
      const revoked = await store.revokeWhere(
        index,
        (record: SessionRecord) =>
          (userId === undefined || record.sub === userId) &&
          (tenantId === undefined || record.tenantId === tenantId),
      );
      for (const record of revoked) {
        audit({
          action: 'auth.session_revoked',
          outcome: 'success',
          userId: record.sub,
          tenantId: record.tenantId,
          reason,
        });
      }
      metrics.sessionRevocation(
        userId === undefined ? 'tenant' : tenantId === undefined ? 'user' : 'user_tenant',
      );

      if (deps.idp === undefined) {
        logger.warn(
          { event: 'auth.idp_logout_skipped', reason },
          'no keycloak admin client configured',
        );
        return { sessions: revoked.length, idpLogout: 'skipped' };
      }
      // A user revoked by id is logged out at Keycloak even with no BFF session left: their SSO session
      // could otherwise sign them straight back in. A tenant-wide revocation reaches the users it ended.
      const subjects = userId === undefined ? [...new Set(revoked.map((r) => r.sub))] : [userId];
      let idpLogout: IdpLogoutOutcome = 'done';
      for (const subject of subjects) {
        if (!(await logoutKeycloak(subject))) idpLogout = 'failed';
      }
      return { sessions: revoked.length, idpLogout };
    },
  };
}
