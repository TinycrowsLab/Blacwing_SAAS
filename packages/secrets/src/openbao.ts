import { AppError } from '@blackwing/errors';

/** Connection settings for OpenBao (AppRole auth). The secret id is a credential: never log it. */
export interface OpenBaoConfig {
  readonly addr: string;
  readonly roleId: string;
  readonly secretId: string;
  /** Enterprise namespace, sent as `X-Vault-Namespace`. */
  readonly namespace?: string;
}

export const DEFAULT_OPENBAO_ADDR = 'http://openbao:8200';

/**
 * Reads `OPENBAO_ADDR` (default {@link DEFAULT_OPENBAO_ADDR}), `OPENBAO_ROLE_ID`, `OPENBAO_SECRET_ID`
 * and optional `OPENBAO_NAMESPACE`. A missing credential is a configuration defect (fail closed).
 */
export function openBaoConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): OpenBaoConfig {
  const roleId = env.OPENBAO_ROLE_ID;
  const secretId = env.OPENBAO_SECRET_ID;
  if (!roleId || !secretId) {
    throw new AppError('CONFIG_INVALID', 'OPENBAO_ROLE_ID and OPENBAO_SECRET_ID must be set');
  }
  const namespace = env.OPENBAO_NAMESPACE;
  return {
    addr: (env.OPENBAO_ADDR === undefined || env.OPENBAO_ADDR === ''
      ? DEFAULT_OPENBAO_ADDR
      : env.OPENBAO_ADDR
    ).replace(/\/+$/, ''),
    roleId,
    secretId,
    ...(namespace ? { namespace } : {}),
  };
}

/** A successful (2xx) or 404 response. `data` is the OpenBao `data` object (undefined when empty). */
export interface OpenBaoResponse {
  readonly status: number;
  readonly data: Record<string, unknown> | undefined;
}

export interface OpenBaoClient {
  /**
   * Calls `/v1/<path>` with the AppRole token. 2xx and 404 resolve; sealed/unreachable/5xx reject with
   * `KEK_UNAVAILABLE`, 403 with `FORBIDDEN`, anything else with `INTERNAL`. Request and response
   * bodies are never put in an error message.
   */
  request(method: string, path: string, body?: unknown): Promise<OpenBaoResponse>;
}

export interface OpenBaoClientDeps {
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Login attempts before giving up (default 4, backoff 200ms doubling). */
  readonly loginAttempts?: number;
  readonly timeoutMs?: number;
}

const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const DEFAULT_LOGIN_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const LOGIN_BACKOFF_MS = 200;
const MS_PER_S = 1000;

// Transit answers 400 with this text for a ciphertext wrapped by a version below min_decryption_version
// (crypto-shredded). Only the matched fact is used; the body is never copied into an error.
const DISABLED_VERSION = /disallowed by policy|version is (disabled|too old)/i;
const errorsOf = (json: unknown): string => {
  const errors = (json as { errors?: unknown } | undefined)?.errors;
  return Array.isArray(errors) ? errors.filter((e) => typeof e === 'string').join(' ') : '';
};

const unavailable = (message: string, cause?: unknown): AppError =>
  new AppError('KEK_UNAVAILABLE', message, { cause, detail: 'The key service is unavailable.' });

/** Token lifetime fraction after which the client re-authenticates before it can expire. */
const REFRESH_AT = 0.8;
const FALLBACK_TTL_S = 3600;

/** An OpenBao HTTP client that logs in with AppRole, caches the token and re-auths on expiry. */
export function createOpenBaoClient(
  config: OpenBaoConfig,
  deps: OpenBaoClientDeps = {},
): OpenBaoClient {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const attempts = deps.loginAttempts ?? DEFAULT_LOGIN_ATTEMPTS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = config.addr.replace(/\/+$/, '');
  let token: { value: string; refreshAt: number } | undefined;
  let inflightLogin: Promise<string> | undefined;

  async function send(
    method: string,
    path: string,
    body: unknown,
    clientToken: string | undefined,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (clientToken !== undefined) headers['x-vault-token'] = clientToken;
    if (config.namespace) headers['x-vault-namespace'] = config.namespace;
    let res: Response;
    try {
      res = await doFetch(`${base}/v1/${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw unavailable('OpenBao is unreachable', cause);
    }
    let json: unknown;
    try {
      const text = await res.text();
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  }

  async function login(): Promise<string> {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(LOGIN_BACKOFF_MS * 2 ** (attempt - 1));
      let res: { status: number; json: unknown };
      try {
        res = await send(
          'POST',
          'auth/approle/login',
          { role_id: config.roleId, secret_id: config.secretId },
          undefined,
        );
      } catch (error) {
        last = error;
        continue;
      }
      const auth = (
        res.json as { auth?: { client_token?: unknown; lease_duration?: unknown } } | undefined
      )?.auth;
      if (res.status === HTTP_OK && typeof auth?.client_token === 'string') {
        const ttl =
          typeof auth.lease_duration === 'number' && auth.lease_duration > 0
            ? auth.lease_duration
            : FALLBACK_TTL_S;
        token = { value: auth.client_token, refreshAt: now() + ttl * MS_PER_S * REFRESH_AT };
        return token.value;
      }
      // Bad credentials are not transient; only a 5xx (sealed, restarting) is worth retrying.
      if (res.status < HTTP_SERVER_ERROR)
        throw unavailable(`OpenBao AppRole login refused (status ${res.status})`);
      last = unavailable(`OpenBao AppRole login failed (status ${res.status})`);
    }
    throw last instanceof AppError ? last : unavailable('OpenBao AppRole login failed', last);
  }

  function ensureToken(): Promise<string> {
    if (token !== undefined && now() < token.refreshAt) return Promise.resolve(token.value);
    inflightLogin ??= login().finally(() => {
      inflightLogin = undefined;
    });
    return inflightLogin;
  }

  return {
    async request(method, path, body) {
      let result = await send(method, path, body, await ensureToken());
      if (result.status === HTTP_FORBIDDEN || result.status === HTTP_UNAUTHORIZED) {
        // Expired/revoked token or a real policy denial: re-authenticate once, then decide.
        token = undefined;
        result = await send(method, path, body, await ensureToken());
      }
      const { status, json } = result;
      if (status >= HTTP_OK && status < HTTP_MULTIPLE_CHOICES) {
        return { status, data: (json as { data?: Record<string, unknown> } | undefined)?.data };
      }
      if (status === HTTP_NOT_FOUND) return { status, data: undefined };
      if (status >= HTTP_SERVER_ERROR) throw unavailable(`OpenBao unavailable (status ${status})`);
      if (status === HTTP_BAD_REQUEST && DISABLED_VERSION.test(errorsOf(json))) {
        throw new AppError(
          'KEK_DISABLED',
          `OpenBao refused a disabled key version (${method} ${path})`,
        );
      }
      if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
        throw new AppError('FORBIDDEN', `OpenBao denied ${method} ${path}`);
      }
      throw new AppError('INTERNAL', `OpenBao rejected ${method} ${path} (status ${status})`);
    },
  };
}
