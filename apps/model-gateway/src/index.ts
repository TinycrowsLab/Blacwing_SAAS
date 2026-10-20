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
  AnthropicStubAdapter,
  type AnthropicStubAdapterOptions,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderRequest,
  type ProviderResponse,
  type SendOptions,
  staticAnthropicCredentials,
} from './provider.js';
export { buildGateway, type GatewayOptions, MESSAGES_ROUTE } from './server.js';
