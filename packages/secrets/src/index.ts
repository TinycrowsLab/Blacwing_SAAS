/** Workspace package name of this package. */
export const name = '@blackwing/secrets';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

// Per-tenant Transit KEK lifecycle (SECRETS-001, §8.6/§8.7).
export {
  createOpenBaoClient,
  DEFAULT_OPENBAO_ADDR,
  openBaoConfigFromEnv,
  type OpenBaoClient,
  type OpenBaoClientDeps,
  type OpenBaoConfig,
  type OpenBaoResponse,
} from './openbao.js';
export {
  createTenantKekService,
  kekKeyName,
  type KekAuditAction,
  type KekAuditEvent,
  type KekInfo,
  type KekMetrics,
  type TenantKekService,
  type TenantKekServiceDeps,
} from './kek.js';

// Envelope encryption: AES-256-GCM data, DEK wrapped by the tenant KEK (SECRETS-002, §8.7).
export {
  createEnvelopeCrypto,
  type Envelope,
  type EnvelopeContext,
  type EnvelopeCrypto,
  type EnvelopeCryptoOptions,
  EnvelopeError,
  type EnvelopeMetrics,
} from './envelope.js';
export { createTransit, type TransitClient } from './transit.js';
