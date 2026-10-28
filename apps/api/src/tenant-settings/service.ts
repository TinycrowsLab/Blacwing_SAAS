import { type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import { hashTenantId } from '@blackwing/db/tenant-context';
import { hasPermission } from '@blackwing/domain';
import { ForbiddenError, NotFoundError, PreconditionRequiredError } from '@blackwing/errors';

import {
  applyTenantSettingsPatch,
  diffTenantSettings,
  parseStoredSettings,
  parseTenantSettingsPatch,
  redactTenantSettingsChanges,
  tenantSettingsEtag,
} from './settings.js';
import { parseIfMatch, requireIfMatch } from '../concurrency/index.js';

import type { TenantSettingsMetrics } from './metrics.js';
import type {
  TenantSettingsMemberships,
  TenantSettingsRecord,
  TenantSettingsStore,
} from './ports.js';
import type { Permission, TenantSettingsResponse } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/api/tenant-settings';
const TENANT_SETTINGS_GET_SPAN = 'tenant_settings.get';
const TENANT_SETTINGS_UPDATE_SPAN = 'tenant_settings.update';

/** The caller: the tenant the guard resolved and the user acting in it. */
export interface TenantSettingsPrincipal {
  readonly tenantId: string;
  readonly actorId: string;
}

/** A settings answer: the body and the ETag that validates it. */
export interface TenantSettingsView {
  readonly body: TenantSettingsResponse;
  readonly etag: string;
}

export interface TenantSettingsServiceDeps {
  readonly store: TenantSettingsStore;
  readonly memberships: TenantSettingsMemberships;
  readonly metrics: TenantSettingsMetrics;
  readonly logger: Pick<Logger, 'info'>;
  readonly tracer?: Tracer;
}

const uuidSchema = z.uuid();

function viewOf(record: TenantSettingsRecord): TenantSettingsView {
  const settings = parseStoredSettings(record.settings);
  return {
    etag: tenantSettingsEtag(settings, record.updatedAt),
    body: { settings, region: record.region, updatedAt: record.updatedAt.toISOString() },
  };
}

/**
 * Tenant settings (TENANT-008): read the settings, and change them under optimistic concurrency. Every
 * call is authorised by the caller's roles in the resolved tenant: any member reads, only a holder of
 * `settings:write` changes. Every committed change writes its audit event in the same transaction.
 */
export class TenantSettingsService {
  private readonly tracer: Tracer;

  constructor(private readonly deps: TenantSettingsServiceDeps) {
    this.tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  }

  async get(principal: TenantSettingsPrincipal): Promise<TenantSettingsView> {
    return this.inSpan(TENANT_SETTINGS_GET_SPAN, async () => {
      await this.authoriseMember(principal);
      const record = await this.deps.store.read(principal.tenantId);
      if (record === undefined) throw new NotFoundError('tenant not found');
      return viewOf(record);
    });
  }

  /**
   * Applies a `PATCH`. Order: authorise, then require `If-Match` (428), then validate the body (422 or
   * `invalid_timezone`), then compare the ETag against the locked row (412). An empty or unchanged patch
   * is a no-op: no write, no audit, and the current ETag comes back.
   */
  async update(
    principal: TenantSettingsPrincipal,
    ifMatch: string | undefined,
    body: unknown,
  ): Promise<TenantSettingsView> {
    return this.inSpan(TENANT_SETTINGS_UPDATE_SPAN, async () => {
      await this.authorise(principal, 'settings:write');
      if (parseIfMatch(ifMatch) === undefined) {
        throw new PreconditionRequiredError('This resource requires an If-Match header.', {
          detail: 'Send the ETag from GET /v1/tenant/settings in If-Match.',
        });
      }
      const patch = parseTenantSettingsPatch(body);
      let changedKeys: readonly string[] = [];
      const { record, changed } = await this.deps.store.update(principal.tenantId, (current) => {
        const settings = parseStoredSettings(current.settings);
        requireIfMatch(tenantSettingsEtag(settings, current.updatedAt), ifMatch);
        const next = applyTenantSettingsPatch(settings, patch);
        const changes = diffTenantSettings(settings, next);
        changedKeys = Object.keys(changes);
        if (changedKeys.length === 0) return undefined;
        return {
          settings: next,
          actorId: principal.actorId,
          changes: redactTenantSettingsChanges(changes),
        };
      });
      if (changed) {
        this.deps.metrics.updated();
        this.deps.logger.info(
          { tenantId: hashTenantId(principal.tenantId), changedKeys },
          'tenant_settings.updated',
        );
      }
      return viewOf(record);
    });
  }

  /** Writes need `settings:write` (org_admin). Fails closed: a non-UUID user id has no membership to read. */
  private async authorise(
    principal: TenantSettingsPrincipal,
    permission: Permission,
  ): Promise<void> {
    const roles = await this.rolesOf(principal);
    if (!hasPermission(roles, permission)) {
      throw new ForbiddenError('the caller may not change tenant settings', {
        detail: `Missing permission ${permission} in this tenant.`,
      });
    }
  }

  /**
   * Reads are open to every member of the tenant: any membership with at least one role. A membership
   * with no roles holds no permissions (RBAC), so it is refused.
   */
  private async authoriseMember(principal: TenantSettingsPrincipal): Promise<void> {
    if ((await this.rolesOf(principal)).length === 0) {
      throw new ForbiddenError('the caller is not a member of this tenant', {
        detail: 'Tenant settings are visible to the members of this tenant.',
      });
    }
  }

  private async rolesOf(principal: TenantSettingsPrincipal): Promise<readonly string[]> {
    const userId = uuidSchema.safeParse(principal.actorId);
    return userId.success ? this.deps.memberships.rolesOf(principal.tenantId, userId.data) : [];
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
