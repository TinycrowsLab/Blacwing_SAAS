/** Workspace package name of this app. */
export const name = '@blackwing/web';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export { type ApiClient, type ApiClientOptions, createApiClient } from './lib/api-client.js';
export { ApiError, isApiError } from './lib/api-error.js';
export { createApiErrorMetrics } from './lib/api-metrics.js';
export { type ApiErrorHandlers, makeQueryClient } from './lib/query-client.js';
export { qk } from './lib/query-keys.js';
