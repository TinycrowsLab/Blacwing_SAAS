/** Workspace package name of this app. */
export const name = '@blackwing/model-gateway';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { anthropicError, errorTypeForStatus } from './anthropic-error.js';
export {
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
export { createGatewayMetrics, type GatewayMetrics } from './metrics.js';
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
