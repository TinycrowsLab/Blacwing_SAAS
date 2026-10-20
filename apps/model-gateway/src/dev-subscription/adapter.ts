// POC-ONLY / offline-stub (#883): routes model calls through the host developer's Claude Code login.
// OFFLINE-STUB(online-porting #884): replaced by the production provider; never for customer runs (§4.5).
import { REDACTED, registerSecretPattern } from '@blackwing/logger';

import { anthropicError } from '../anthropic-error.js';
import { HTTP_STATUS } from '../http-status.js';
import { DevSubscriptionLoginError, type DevSubscriptionCredentialSource } from './credentials.js';
import {
  DEV_SUBSCRIPTION_PROVIDER_ID,
  type DevSubscriptionEnvironment,
  assertDevSubscriptionAllowed,
  devSubscriptionRefusal,
} from './guard.js';
import { redactSecretsInStream } from './redact-stream.js';

import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderRequest,
  ProviderResponse,
  SendOptions,
} from '../provider.js';
import type { AnthropicErrorType } from '@blackwing/contracts';

/** Beta flag the Anthropic API requires for OAuth (subscription) bearer tokens. */
export const DEV_SUBSCRIPTION_OAUTH_BETA = 'oauth-2025-04-20';
/** `retry-after` (seconds) added to a subscription 429 that carries no retry hint of its own. */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MS_PER_SECOND = 1000;
/** Unified (subscription) rate-limit reset header: epoch seconds. */
const UNIFIED_RESET_HEADER = 'anthropic-ratelimit-unified-reset';
/** Claude subscription OAuth access/refresh token format, redacted from logs even before a value is known. */
const OAUTH_TOKEN_PATTERN = /sk-ant-o[ar]t[0-9]{2}-[A-Za-z0-9_-]+/;

export interface DevSubscriptionAdapterOptions {
  readonly baseUrl: string;
  readonly credentials: DevSubscriptionCredentialSource;
  /** Dev/demo tenants this provider serves; every other tenant is denied. */
  readonly allowedTenantIds: readonly string[];
  /** Re-evaluated on every request, so the env guard is enforced per call as well as at boot. */
  readonly environment: () => DevSubscriptionEnvironment;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

function errorResponse(
  status: number,
  type: AnthropicErrorType,
  message: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): ProviderResponse {
  const bytes = Buffer.from(JSON.stringify(anthropicError(type, message)), 'utf8');
  const headers = new Headers({ 'content-type': 'application/json', ...extraHeaders });
  async function* body(): AsyncGenerator<Uint8Array> {
    yield await Promise.resolve(bytes);
  }
  return { status, headers, body: body() };
}

/**
 * Upstream answer headers made safe for the client: any value containing a login secret is redacted, and
 * a 429 always carries `retry-after` (from the unified reset header, else a default).
 */
function safeResponseHeaders(
  status: number,
  upstream: Headers,
  secrets: readonly string[],
  now: number,
): Headers {
  const headers = new Headers();
  upstream.forEach((value, name) => {
    headers.set(name, secrets.some((secret) => value.includes(secret)) ? REDACTED : value);
  });
  if (status !== HTTP_STATUS.tooManyRequests || headers.has('retry-after')) return headers;
  const reset = Number(headers.get(UNIFIED_RESET_HEADER));
  const seconds =
    Number.isFinite(reset) && reset > 0
      ? Math.max(1, Math.ceil(reset - now / MS_PER_SECOND))
      : DEFAULT_RETRY_AFTER_SECONDS;
  headers.set('retry-after', String(seconds));
  return headers;
}

/**
 * `dev_subscription` provider: a streaming passthrough to the Anthropic Messages API that authenticates
 * with the host's Claude Code login. The sandbox only ever holds its virtual key; this adapter swaps in
 * the upstream credential server-side, denies non-dev tenants, never falls back to another credential,
 * and redacts the login from everything it returns.
 */
export class DevSubscriptionAdapter implements ProviderAdapter {
  readonly name = DEV_SUBSCRIPTION_PROVIDER_ID;
  readonly #base: URL;
  readonly #credentials: DevSubscriptionCredentialSource;
  readonly #tenants: ReadonlySet<string>;
  readonly #environment: () => DevSubscriptionEnvironment;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: DevSubscriptionAdapterOptions) {
    assertDevSubscriptionAllowed(options.environment());
    registerSecretPattern('claude-oauth-token', OAUTH_TOKEN_PATTERN);
    this.#base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
    this.#credentials = options.credentials;
    this.#tenants = new Set(options.allowedTenantIds);
    this.#environment = options.environment;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  ready(): boolean {
    return devSubscriptionRefusal(this.#environment()) === undefined;
  }

  /** The dev provider forwards the client's model id unchanged (aliases are GATEWAY-008). */
  resolveModelId(aliasOrId: string): string {
    return aliasOrId;
  }

  /** Local check only (guard and login present and unexpired); it never calls the upstream. */
  async healthCheck(): Promise<ProviderHealth> {
    const refusal = devSubscriptionRefusal(this.#environment());
    if (refusal !== undefined) return { healthy: false, reachable: false, detail: 'refused' };
    try {
      await this.#credentials.read();
      return { healthy: true, reachable: true };
    } catch (error) {
      const detail =
        error instanceof DevSubscriptionLoginError ? `login_${error.problem}` : 'login_error';
      return { healthy: false, reachable: false, detail };
    }
  }

  async send(request: ProviderRequest, options: SendOptions): Promise<ProviderResponse> {
    const refusal = devSubscriptionRefusal(this.#environment());
    if (refusal !== undefined) {
      return errorResponse(HTTP_STATUS.forbidden, 'permission_error', refusal);
    }
    const principal = request.principal;
    if (principal === undefined) {
      return errorResponse(
        HTTP_STATUS.unauthorized,
        'authentication_error',
        'A per-session virtual key is required.',
      );
    }
    if (!this.#tenants.has(principal.tenantId)) {
      return errorResponse(
        HTTP_STATUS.forbidden,
        'permission_error',
        'The dev subscription provider serves only the dev/demo tenant.',
      );
    }

    let credential;
    try {
      credential = await this.#credentials.read();
    } catch (error) {
      if (error instanceof DevSubscriptionLoginError) {
        return errorResponse(HTTP_STATUS.unauthorized, 'authentication_error', error.message);
      }
      throw error;
    }

    const url = new URL(request.pathAndQuery.replace(/^\/+/, ''), this.#base);
    const headers = new Headers(request.headers);
    headers.delete('x-api-key');
    headers.set('authorization', `Bearer ${credential.accessToken}`);
    const betas = (headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim())
      .filter((beta) => beta.length > 0);
    if (!betas.includes(DEV_SUBSCRIPTION_OAUTH_BETA)) betas.push(DEV_SUBSCRIPTION_OAUTH_BETA);
    headers.set('anthropic-beta', betas.join(','));

    const response = await this.#fetch(url, {
      method: 'POST',
      headers,
      body: request.body,
      signal: options.signal,
      redirect: 'manual',
    });
    return {
      status: response.status,
      headers: safeResponseHeaders(
        response.status,
        response.headers,
        credential.secretValues,
        this.#now(),
      ),
      body:
        response.body === null
          ? null
          : redactSecretsInStream(response.body, credential.secretValues),
    };
  }
}
