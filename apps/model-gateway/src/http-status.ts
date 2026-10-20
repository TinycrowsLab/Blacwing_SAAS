/** HTTP status codes the gateway produces itself. */
export const HTTP_STATUS = {
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  payloadTooLarge: 413,
  tooManyRequests: 429,
  internalError: 500,
  badGateway: 502,
  serviceUnavailable: 503,
  gatewayTimeout: 504,
  overloaded: 529,
  /** Exclusive upper bound of valid status codes. */
  upperBound: 600,
} as const;
