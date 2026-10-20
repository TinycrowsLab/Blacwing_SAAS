import type { AnthropicErrorType } from '@blackwing/contracts';

/** Stable codes of provider-side failures. They appear in the Anthropic error `message`, never carry secrets. */
export type ProviderErrorCode =
  | 'PROVIDER_CRED_UNSUPPORTED'
  | 'PROVIDER_CRED_MISSING'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_TIMEOUT';

/**
 * A failure the adapter maps to a client-facing Anthropic error. `message` is safe to return to the
 * client: it never contains credentials or request bodies.
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus: number;
  readonly errorType: AnthropicErrorType;
  readonly retryable: boolean;

  constructor(options: {
    readonly code: ProviderErrorCode;
    readonly httpStatus: number;
    readonly errorType: AnthropicErrorType;
    readonly message: string;
    readonly retryable: boolean;
  }) {
    super(`${options.code}: ${options.message}`);
    this.name = 'ProviderError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.errorType = options.errorType;
    this.retryable = options.retryable;
  }
}
