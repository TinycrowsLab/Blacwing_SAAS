import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import { z } from 'zod';

import { AppError } from '@blackwing/errors';

import type { KeycloakMetrics } from './metrics.js';
import type { KeycloakAdminSettings } from './settings.js';
import type { Logger } from '@blackwing/logger';

/** The logical operation, a label on `keycloak_admin_calls_total`. */
export type KeycloakAdminOp =
  | 'create'
  | 'list'
  | 'get'
  | 'update'
  | 'delete'
  | 'add_member'
  | 'remove_member'
  | 'idp_get'
  | 'idp_create'
  | 'idp_update'
  | 'idp_delete'
  | 'idp_link'
  | 'idp_unlink'
  | 'idp_links'
  | 'idp_mapper_list'
  | 'idp_mapper_create'
  | 'idp_mapper_update'
  | 'idp_mapper_delete';

type KeycloakAdminMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * What one admin call answered. A 2xx is `ok`; a 404 and a 409 are returned so the caller decides what they mean
 * (idempotent no-op or error). Every other status is thrown as an `AppError` with a stable code.
 */
type KeycloakAdminResult =
  | { readonly kind: 'ok'; readonly body: unknown; readonly location: string | undefined }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict' };

export interface KeycloakAdminClient {
  /** `path` is relative to `/admin/realms/<realm>/` and may carry a query string. */
  request(
    op: KeycloakAdminOp,
    method: KeycloakAdminMethod,
    path: string,
    body?: unknown,
  ): Promise<KeycloakAdminResult>;
}

export interface KeycloakAdminClientDeps {
  readonly settings: KeycloakAdminSettings;
  /** Reads the client secret by reference (OpenBao). Called again after a rejected token, so rotation is picked up. */
  readonly readClientSecret: () => Promise<string>;
  readonly metrics: KeycloakMetrics;
  readonly logger: Logger;
  /** The HTTP transport; the global `fetch` by default. */
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Tries per request for transient failures (network, 429, 5xx). Default 3. */
  readonly attempts?: number;
  /** One span per logical admin call. Defaults to the API tracer. */
  readonly tracer?: Tracer;
}

/** Fraction of the token lifetime after which the token is renewed, so it never expires mid-request. */
const TOKEN_REFRESH_FRACTION = 0.8;
const MS_PER_S = 1000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 200;
const TRACER_NAME = '@blackwing/api/keycloak';

const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

interface RawResponse {
  readonly status: number;
  readonly json: unknown;
  readonly location: string | undefined;
}

/** Network failures, 429 and 5xx are worth retrying; everything else is an answer. */
const transient = (status: number): boolean =>
  status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR;

const parseJson = (text: string): unknown => {
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const unavailable = (cause?: unknown): AppError =>
  new AppError('KEYCLOAK_UNAVAILABLE', 'Keycloak is unavailable', {
    ...(cause === undefined ? {} : { cause }),
    detail: 'The identity provider is unavailable. Retry later.',
  });

/** The message names the operation and status only: Keycloak bodies can carry user data, so they are never copied. */
const rejected = (what: string, status: number): AppError =>
  new AppError('KEYCLOAK_REJECTED', `Keycloak refused ${what} (status ${status})`, {
    detail: 'The identity provider rejected the admin request.',
  });

/**
 * The Keycloak Admin REST client (IAM-002). It holds one cached access token obtained with the `client_credentials`
 * grant from the dedicated service-account client, renews it at 80% of its lifetime and re-reads the secret after a
 * 401. It is server-side only: the token and secret never leave this process.
 */
export function createKeycloakAdminClient(deps: KeycloakAdminClientDeps): KeycloakAdminClient {
  const { settings, metrics, logger } = deps;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;
  const tracer = deps.tracer ?? trace.getTracer(TRACER_NAME);
  const realmBase = `${settings.baseUrl}/admin/realms/${encodeURIComponent(settings.realm)}`;
  const tokenUrl = `${settings.baseUrl}/realms/${encodeURIComponent(settings.realm)}/protocol/openid-connect/token`;

  let secret: string | undefined;
  let token: { readonly value: string; readonly refreshAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  /** One HTTP exchange, retrying transport failures and transient statuses with exponential backoff. */
  async function exchange(
    url: string,
    init: {
      readonly method: string;
      readonly headers: Record<string, string>;
      readonly body?: string;
    },
  ): Promise<RawResponse> {
    for (let attempt = 1; ; attempt++) {
      const last = attempt >= attempts;
      try {
        const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        const raw: RawResponse = {
          status: res.status,
          json: parseJson(await res.text()),
          location: res.headers.get('location') ?? undefined,
        };
        if (!transient(raw.status) || last) return raw;
      } catch (cause) {
        if (last) throw unavailable(cause);
      }
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }

  async function fetchToken(forceFresh: boolean): Promise<string> {
    if (forceFresh) {
      token = undefined;
      secret = undefined;
    }
    secret ??= await deps.readClientSecret();
    const raw = await exchange(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: settings.clientId,
        client_secret: secret,
      }).toString(),
    });
    if (raw.status === HTTP_OK) {
      const parsed = tokenSchema.safeParse(raw.json);
      if (!parsed.success) throw rejected('the token request', raw.status);
      token = {
        value: parsed.data.access_token,
        refreshAt: now() + parsed.data.expires_in * MS_PER_S * TOKEN_REFRESH_FRACTION,
      };
      return token.value;
    }
    if (transient(raw.status)) throw unavailable();
    throw rejected('the token request', raw.status);
  }

  /** Concurrent callers share one refresh. */
  function accessToken(forceFresh: boolean): Promise<string> {
    if (!forceFresh && token !== undefined && now() < token.refreshAt) {
      return Promise.resolve(token.value);
    }
    inflight ??= fetchToken(forceFresh).finally(() => {
      inflight = undefined;
    });
    return inflight;
  }

  function adminRequest(
    method: KeycloakAdminMethod,
    path: string,
    accessTokenValue: string,
    body: unknown,
  ): Promise<RawResponse> {
    return exchange(`${realmBase}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessTokenValue}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  function classify(op: KeycloakAdminOp, raw: RawResponse): KeycloakAdminResult {
    if (raw.status >= HTTP_OK && raw.status < HTTP_MULTIPLE_CHOICES) {
      return { kind: 'ok', body: raw.json, location: raw.location };
    }
    if (raw.status === HTTP_NOT_FOUND) return { kind: 'not_found' };
    if (raw.status === HTTP_CONFLICT) return { kind: 'conflict' };
    if (transient(raw.status)) {
      throw new AppError(
        'KEYCLOAK_UNAVAILABLE',
        `Keycloak is unavailable (${op}, status ${raw.status})`,
        {
          detail: 'The identity provider is unavailable. Retry later.',
        },
      );
    }
    throw rejected(op, raw.status);
  }

  return {
    request(op, method, path, body) {
      return tracer.startActiveSpan(`keycloak.admin.${op}`, async (span) => {
        let result = 'error';
        try {
          let raw = await adminRequest(method, path, await accessToken(false), body);
          if (raw.status === HTTP_UNAUTHORIZED) {
            // The token was revoked or the secret rotated: renew once with a fresh secret, then decide.
            raw = await adminRequest(method, path, await accessToken(true), body);
          }
          const outcome = classify(op, raw);
          result = outcome.kind;
          logger.debug({ op, result }, 'keycloak admin call');
          return outcome;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          logger.warn(
            { op, code: error instanceof AppError ? error.code : 'UNKNOWN' },
            'keycloak admin call failed',
          );
          throw error;
        } finally {
          metrics.calls.inc({ op, result });
          span.setAttributes({ 'bw.keycloak.op': op, 'bw.keycloak.result': result });
          span.end();
        }
      });
    },
  };
}
