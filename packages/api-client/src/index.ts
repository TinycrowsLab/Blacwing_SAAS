/** Workspace package name of this package. */
export const name = '@blackwing/api-client';

/** Package version; kept in sync with package.json. */
export const version = '0.0.0';

export {
  apiAuthSchema,
  createApiClient,
  type ApiAuth,
  type ApiClient,
  type ApiClientOptions,
  type ApiResponse,
  type OperationData,
  type OperationId,
  type OperationInput,
} from './client.js';
export { ApiNetworkError, ApiProblemError, ApiResponseError } from './errors.js';
export { paginate, type PaginateOptions } from './paginate.js';
export {
  withIdempotencyKey,
  withIfMatch,
  withTraceparent,
  type RequestOptions,
} from './request-options.js';
