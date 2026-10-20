import { HTTP_STATUS } from './http-status.js';

import type { AnthropicErrorBody, AnthropicErrorType } from '@blackwing/contracts';

/**
 * Builds the Anthropic error envelope. The gateway answers in this shape (not RFC 9457) so Claude Code
 * handles gateway errors exactly like upstream errors.
 */
export function anthropicError(type: AnthropicErrorType, message: string): AnthropicErrorBody {
  return { type: 'error', error: { type, message } };
}

const TYPE_BY_STATUS: ReadonlyMap<number, AnthropicErrorType> = new Map<number, AnthropicErrorType>(
  [
    [HTTP_STATUS.unauthorized, 'authentication_error'],
    [HTTP_STATUS.forbidden, 'permission_error'],
    [HTTP_STATUS.notFound, 'not_found_error'],
    [HTTP_STATUS.payloadTooLarge, 'request_too_large'],
    [HTTP_STATUS.tooManyRequests, 'rate_limit_error'],
    [HTTP_STATUS.gatewayTimeout, 'timeout_error'],
    [HTTP_STATUS.overloaded, 'overloaded_error'],
  ],
);

/** Maps an HTTP status the gateway produces itself to the matching Anthropic error type. */
export function errorTypeForStatus(status: number): AnthropicErrorType {
  const mapped = TYPE_BY_STATUS.get(status);
  if (mapped !== undefined) return mapped;
  return status >= HTTP_STATUS.badRequest && status < HTTP_STATUS.internalError
    ? 'invalid_request_error'
    : 'api_error';
}
