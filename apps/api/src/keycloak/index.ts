import { createKeycloakAdminClient } from './admin-client.js';
import { createOpenBaoClientSecretReader } from './client-secret.js';
import { createKeycloakMetrics, type KeycloakMetrics } from './metrics.js';
import { OrganizationsService, type OrganizationAuditSink } from './organizations.service.js';
import { type KeycloakAdminEnv, keycloakAdminSettingsFrom } from './settings.js';

import type { Logger } from '@blackwing/logger';
import type { OpenBaoClient } from '@blackwing/secrets';

export { OrganizationsService } from './organizations.service.js';

export interface CreateOrganizationsServiceOptions {
  readonly env: KeycloakAdminEnv;
  readonly openBao: OpenBaoClient;
  readonly audit: OrganizationAuditSink;
  readonly logger: Logger;
  /** Pass one shared instance so its counter is exported on a scrape. Defaults to a private registry. */
  readonly metrics?: KeycloakMetrics;
}

/**
 * Builds the organisations service for TENANT-005 and IAM-003/004. Server-side only. It refuses to build (throws
 * `CONFIG_INVALID`) unless all four `KEYCLOAK_*` admin keys are set, so a partly configured API never runs with
 * a missing credential.
 */
export function createOrganizationsService(
  options: CreateOrganizationsServiceOptions,
): OrganizationsService {
  const settings = keycloakAdminSettingsFrom(options.env);
  const client = createKeycloakAdminClient({
    settings,
    readClientSecret: createOpenBaoClientSecretReader(options.openBao, settings.secretPath),
    metrics: options.metrics ?? createKeycloakMetrics(),
    logger: options.logger,
  });
  return new OrganizationsService({ client, audit: options.audit, logger: options.logger });
}
