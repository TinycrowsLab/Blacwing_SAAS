// Request authentication for the harness (PERF-001, #320). Tokens come only from PERF_TOKEN (environment or a
// secret reference); this module never logs or returns a token except inside the Authorization header.

/**
 * @param {{ token: string, tenantId: string | undefined }} config from loadConfig()
 * @returns {Record<string, string>} headers for every request: Bearer token, plus X-Tenant when a tenant is pinned
 */
export function authHeaders(config) {
  /** @type {Record<string, string>} */
  const headers = { Authorization: `Bearer ${config.token}`, Accept: 'application/json' };
  if (config.tenantId !== undefined) headers['X-Tenant'] = config.tenantId;
  return headers;
}

/**
 * Removes every occurrence of the token from text, for any output that might carry it.
 *
 * @param {string} text
 * @param {string} token
 * @returns {string}
 */
export function redact(text, token) {
  return token === '' ? text : text.split(token).join('[redacted]');
}
