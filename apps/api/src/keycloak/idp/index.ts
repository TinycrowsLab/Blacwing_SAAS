import { createKeycloakAdminClient } from '../admin-client.js';
import { createOpenBaoClientSecretReader, createOpenBaoSecretRefReader } from '../client-secret.js';
import { createKeycloakMetrics, type KeycloakMetrics } from '../metrics.js';
import { keycloakAdminSettingsFrom, type KeycloakAdminEnv } from '../settings.js';
import {
  type IdentityProviderAuditSink,
  IdentityProviderService,
} from './identity-provider.service.js';

import type { FetchLike } from './bounded-fetch.js';
import type { Logger } from '@blackwing/logger';
import type { OpenBaoClient } from '@blackwing/secrets';

export interface CreateIdentityProviderServiceOptions {
  readonly env: KeycloakAdminEnv;
  readonly openBao: OpenBaoClient;
  readonly audit: IdentityProviderAuditSink;
  readonly logger: Logger;
  /** Resolves a tenant to its Keycloak Organization id (TENANT-005). `undefined` when the tenant has none. */
  readonly organizationIdFor: (tenantId: string) => Promise<string | undefined>;
  /** Pass one shared instance so its series are exported on a scrape. Defaults to a private registry. */
  readonly metrics?: KeycloakMetrics;
  /** The HTTP transport for discovery, metadata and the SP descriptor. The global `fetch` by default. */
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Builds the per-org identity provider service (IAM-004). It refuses to build unless the Keycloak admin keys are
 * all set (fail closed), like the organisations service. Client secrets are read from OpenBao at configure time.
 */
export function createIdentityProviderService(
  options: CreateIdentityProviderServiceOptions,
): IdentityProviderService {
  const settings = keycloakAdminSettingsFrom(options.env);
  const metrics = options.metrics ?? createKeycloakMetrics();
  const client = createKeycloakAdminClient({
    settings,
    readClientSecret: createOpenBaoClientSecretReader(options.openBao, settings.secretPath),
    metrics,
    logger: options.logger,
  });
  return new IdentityProviderService({
    client,
    audit: options.audit,
    metrics,
    logger: options.logger,
    organizationIdFor: options.organizationIdFor,
    readSecretRef: createOpenBaoSecretRefReader(options.openBao),
    fetch: options.fetch ?? fetch,
    realmUrl: `${settings.baseUrl}/realms/${encodeURIComponent(settings.realm)}`,
    now: options.now ?? (() => new Date()),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}
