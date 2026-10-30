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
  SECRET_VALUE_PURPOSE,
  type EnvelopeMetrics,
} from './envelope.js';
export { createTransit, type TransitClient } from './transit.js';

// Standing-authorisation JWS signing on Transit and its JWK Set (AUTHZ-004, §8.7/§8.8).
export {
  createSigningKeyService,
  DEFAULT_JWKS_TTL_S,
  DEFAULT_SIGNING_KEY_NAME,
  DEFAULT_TRANSIT_MOUNT,
  signingConfigFromEnv,
  type SignedEnvelope,
  type SigningAuditEvent,
  type SigningConfig,
  type SigningKeyService,
  type SigningKeyServiceDeps,
  type SigningMetrics,
} from './signing.js';

// Per-run redaction registry and its internal endpoint (SECRETS-007, §8.7).
export {
  createRedactionRegistry,
  redactFailClosed,
  type RedactionAuditAction,
  type RedactionAuditEvent,
  type RedactionMetrics,
  type RedactionRegistry,
  type RedactionRegistryDeps,
  type RedactionStream,
  type RedactResult,
  type RegisterInput,
} from './redaction.js';
export {
  createRedactionHandler,
  isInternalAddress,
  redactionRunToken,
  type RedactionHandlerDeps,
} from './redaction-endpoint.js';

// Pluggable secret backends: `kek_wrap` (BYOK) and `external_store` (BYO-vault) behind one registry (issue #112, §8.6, §8.7).
export {
  createBackendRegistry,
  DEFAULT_SECRET_BACKEND,
  type SecretBackendRegistry,
  type SecretBackendRegistryDeps,
} from './backends/registry.js';
export { createOpenBaoBackend, type OpenBaoBackendDeps } from './backends/openbao.js';
export { createRegistryFetcher } from './backends/fetcher.js';
export {
  assertStorageShape,
  type ExternalSecretRow,
  storeExternalSecret,
  type SecretStorageShape,
} from './backends/storage.js';
export {
  type BackendHealth,
  type BackendOp,
  type BackendSpan,
  type BackendTelemetry,
  type ExternalLocator,
  type ExternalStoreBackend,
  type KekWrapBackend,
  type SecretBackendImpl,
  type SecretBackendMetrics,
  type SecretBackendMode,
} from './backends/types.js';

// Internal resolve API: the single audited read path for secret values (SECRETS-006, §8.7).
export {
  createSecretResolver,
  DEFAULT_SERVICE_MATRIX,
  SECRET_PURPOSES,
  type ExternalSecretFetcher,
  type ResolveAuthorizationQuery,
  type ResolveCaller,
  type ResolveInput,
  type ResolveLogEntry,
  type ResolveMetrics,
  type ResolvedSecret,
  type RunStanding,
  type RunStandingReader,
  type SecretRecord,
  type SecretResolver,
  type SecretResolverDeps,
  type SecretStore,
  type ServiceGrant,
} from './resolve.js';
export {
  createSecretResolveHandler,
  resolveRequestSchema,
  SECRET_RESOLVE_PATH,
  type SecretResolveHandlerDeps,
} from './resolve-endpoint.js';
export {
  DEFAULT_RESOLVE_RATE_LIMIT_PER_MINUTE,
  MAX_RESOLVE_CACHE_TTL_MS,
  resolveConfigFromEnv,
  type ResolveConfig,
} from './resolve-config.js';
export { createPgSecretStore, type RunInTenant, type TenantSql } from './resolve-store.js';

// Secret value rotation, KEK rotation and the batched DEK rewrap (SECRETS-012, §8.6, §8.7, §8.8).
export {
  createSecretRotation,
  type KekRotationResult,
  type RewrapCandidate,
  type RotateSecretInput,
  type RotateSecretResult,
  type RotationCommit,
  type RotationMetrics,
  type RotationRecord,
  type RotationStore,
  type SecretRotationAuditEvent,
  type SecretRotationDeps,
  type SecretRotationService,
} from './rotation.js';
export { createPgRotationStore } from './rotation-store.js';
export {
  DEFAULT_KEK_ROTATION_CRON,
  DEFAULT_SECRET_VERSION_GRACE_MS,
  MAX_SECRET_VERSION_GRACE_MS,
  MIN_SECRET_VERSION_GRACE_MS,
  rotationConfigFromEnv,
  type RotationConfig,
} from './rotation-config.js';
export {
  createServiceTokenVerifier,
  SECRET_SERVICES,
  ServiceAuthError,
  signServiceToken,
  type SecretService,
  type ServiceAuthFailure,
  type ServiceIdentity,
  type ServiceTokenRevocations,
  type ServiceTokenVerifier,
  type SignServiceTokenInput,
} from './service-auth.js';
