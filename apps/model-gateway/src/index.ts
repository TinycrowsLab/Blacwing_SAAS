/** Workspace package name of this app. */
export const name = '@blackwing/model-gateway';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { anthropicError, errorTypeForStatus } from './anthropic-error.js';
export { type GatewayAuditEvent, type GatewayAuditSink, loggerAuditSink } from './audit.js';
export {
  type ClientKeyVerifier,
  type ClientPrincipal,
  extractClientKey,
  staticVirtualKeyVerifier,
} from './auth.js';
export { bootGateway, type BootDependencies, type BootedGateway, runGateway } from './boot.js';
export {
  DEFAULT_RETRY_AFTER_SECONDS,
  DEV_SUBSCRIPTION_OAUTH_BETA,
  DevSubscriptionAdapter,
  type DevSubscriptionAdapterOptions,
} from './dev-subscription/adapter.js';
export { announceDevSubscription } from './dev-subscription/banner.js';
export {
  ClaudeCodeLoginStore,
  defaultClaudeCodeCredentialsPath,
  type DevSubscriptionCredential,
  type DevSubscriptionCredentialSource,
  DevSubscriptionLoginError,
} from './dev-subscription/credentials.js';
export {
  assertDevSubscriptionAllowed,
  DEV_SUBSCRIPTION_BANNER,
  DEV_SUBSCRIPTION_PROVIDER_ID,
  devSubscriptionRefusal,
  devSubscriptionRequested,
  DevSubscriptionRefusedError,
} from './dev-subscription/guard.js';
export { redactSecretsInStream } from './dev-subscription/redact-stream.js';
export {
  BW_ENVIRONMENTS,
  type BwEnvironment,
  DEFAULT_DEV_SUBSCRIPTION_BANNER_INTERVAL_MS,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  type GatewayConfig,
  gatewayEnvSchema,
  gatewayEnvShape,
  loadGatewayConfig,
  PROVIDER_IDS,
  type ProviderId,
} from './config.js';
export {
  type ForwardedRequestHeaders,
  forwardRequestHeaders,
  forwardResponseHeaders,
} from './headers.js';
export { createGatewayMetrics, type GatewayMetrics, NO_PROVIDER_LABEL } from './metrics.js';
export {
  type ProviderAdapter,
  type ProviderHealth,
  type ProviderRequest,
  type ProviderResponse,
  type SendOptions,
} from './provider.js';
export {
  AnthropicAdapter,
  type AnthropicAdapterOptions,
  type ProviderCallAuditEvent,
} from './providers/anthropic.js';
export {
  type ProviderCredential,
  requireApiKey,
  type ResolveProviderCredential,
  staticApiKeyResolver,
} from './providers/credentials.js';
export { ProviderError, type ProviderErrorCode } from './providers/errors.js';
export { buildGateway, type GatewayOptions, MESSAGES_ROUTE } from './server.js';
