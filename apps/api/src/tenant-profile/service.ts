import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import { hashTenantId } from '@blackwing/db/tenant-context';
import { hasPermission } from '@blackwing/domain';
import {
  EtagMismatchError,
  ForbiddenRoleError,
  NotFoundError,
  PreconditionRequiredError,
} from '@blackwing/errors';

import {
  applyOrgSettingsPatch,
  diffOrgFields,
  orgFieldsOf,
  orgProfileEtag,
  orgProfileView,
  parseOrgSettingsPatch,
} from './profile.js';
import { parseIfMatch } from '../concurrency/index.js';
import { parseStoredSettings } from '../tenant-settings/settings.js';

import type { TenantProfileMetrics } from './metrics.js';
import type { TenantProfileRecord, TenantProfileStore } from './ports.js';
import type { TenantSettingsMemberships } from '../tenant-settings/ports.js';
import type { OrgProfile, Permission } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/tenant-profile';
const TENANT_PROFILE_GET_SPAN = 'tenant_profile.get';
const TENANT_PROFILE_UPDATE_SPAN = 'tenant_profile.update';

/** The caller: the tenant the guard resolved and the user acting in it. */
export interface TenantProfilePrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

/** A profile answer: the body and the ETag that validates it. */
export interface TenantProfileView {
  readonly body: OrgProfile;
  readonly etag: string;
}

export interface TenantProfileServiceDeps {
  readonly store: TenantProfileStore;
  readonly memberships: TenantSettingsMemberships;
  readonly metrics: TenantProfileMetrics;
  readonly logger: Pick<Logger, 'info'>;
  readonly tracer?: Tracer;
}

const uuidSchema = z.uuid();

function viewOf(record: TenantProfileRecord): TenantProfileView {
  const settings = parseStoredSettings(record.settings);
  return {
    etag: orgProfileEtag(record.name, settings, record.updatedAt),
    body: orgProfileView(record),
  };
}

/**
 * Organisation profile (ADMIN-001): read the profile, and change it under optimistic concurrency. Only a
 * tenant administrator (`settings:read` to see it, `settings:write` to change it, both `org_admin`) reaches
 * it; any other role, or no membership, is `FORBIDDEN_ROLE`. The tenant comes from the resolved context, never
 * from the client. Every committed change writes its audit event in the same transaction.
 */
export class TenantProfileService {
  private readonly tracer: Tracer;

  constructor(private readonly deps: TenantProfileServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  async get(principal: TenantProfilePrincipal): Promise<TenantProfileView> {
    return this.inSpan(TENANT_PROFILE_GET_SPAN, async () => {
      await this.authorise(principal, 'settings:read');
      const record = await this.deps.store.read(principal.tenantId);
      if (record === undefined) throw new NotFoundError('tenant not found');
      return viewOf(record);
    });
  }

  /**
   * Applies a `PATCH`. Order: authorise, then require `If-Match` (428), then validate the body (422), then
   * compare the ETag with the locked row (`ETAG_MISMATCH`). An empty or unchanged body is a no-op: no write,
   * no audit, and the current ETag comes back.
   */
  async update(
    principal: TenantProfilePrincipal,
    ifMatch: string | undefined,
    body: unknown,
  ): Promise<TenantProfileView> {
    return this.inSpan(TENANT_PROFILE_UPDATE_SPAN, async () => {
      try {
        await this.authorise(principal, 'settings:write');
        const precondition = parseIfMatch(ifMatch);
        if (precondition === undefined) {
          throw new PreconditionRequiredError('This resource requires an If-Match header.', {
            detail: 'Send the ETag from GET /v1/tenants/current in If-Match.',
          });
        }
        const patch = parseOrgSettingsPatch(body);
        let changedKeys: readonly string[] = [];
        const { record, changed } = await this.deps.store.update(principal.tenantId, (current) => {
          const settings = parseStoredSettings(current.settings);
          const etag = orgProfileEtag(current.name, settings, current.updatedAt);
          if (precondition.kind === 'tags' && !precondition.etags.includes(etag)) {
            throw new EtagMismatchError();
          }
          const next = applyOrgSettingsPatch(settings, current.name, patch);
          const changes = diffOrgFields(
            orgFieldsOf(current.name, settings),
            orgFieldsOf(next.name, next.settings),
          );
          changedKeys = Object.keys(changes);
          if (changedKeys.length === 0) return undefined;
          return {
            name: next.name,
            settings: next.settings,
            actorId: principal.actorId,
            changes,
          };
        });
        if (changed) {
          this.deps.logger.info(
            {
              component: 'settings-org',
              tenantId: hashTenantId(principal.tenantId),
              actor: principal.actorId,
              changedKeys,
            },
            'org_settings.updated',
          );
        }
        this.deps.metrics.saved('ok');
        return viewOf(record);
      } catch (error) {
        this.deps.metrics.saved('error');
        throw error;
      }
    });
  }

  /** Requires `permission` in the caller's roles in the resolved tenant. Fails closed: a non-UUID user has no membership. */
  private async authorise(
    principal: TenantProfilePrincipal,
    permission: Permission,
  ): Promise<void> {
    const userId = uuidSchema.safeParse(principal.actorId);
    const roles = userId.success
      ? await this.deps.memberships.rolesOf(principal.tenantId, userId.data)
      : [];
    if (!hasPermission(roles, permission)) {
      throw new ForbiddenRoleError('the caller role may not manage the organisation profile', {
        detail: `Organisation settings need the ${permission} permission in this tenant.`,
      });
    }
  }

  private async inSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span: Span) => {
      try {
        return await fn();
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
