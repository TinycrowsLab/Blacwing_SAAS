import { z } from 'zod';

import { problemSchema, type Problem } from '@blackwing/contracts';

import { ApiNetworkError, ApiProblemError, ApiResponseError } from './errors.js';
import { OPERATIONS, type OperationId } from './generated/operations.js';
import { RESPONSE_SCHEMAS } from './response-schemas.js';

import type { operations } from './generated/schema.js';
import type { RequestOptions } from './request-options.js';

export type { OperationId } from './generated/operations.js';

const MAX_COOKIE_LENGTH = 8192;

/** The credential injected on every request. A bearer token is never logged or copied into an error. */
export const apiAuthSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cookie'),
    cookie: z
      .string()
      .min(1)
      .max(MAX_COOKIE_LENGTH)
      .regex(/^[^\r\n]+$/),
  }),
  z.object({ kind: z.literal('bearer'), token: z.string().regex(/^bw_(?:pat|ci)_[\x21-\x7e]+$/) }),
]);
export type ApiAuth = z.infer<typeof apiAuthSchema>;

export interface ApiClientOptions {
  /** The origin of the API, for example `https://api.blackwing.example`. Must be https. */
  readonly baseUrl: string;
  /** Returns the credential for each request: a session cookie (web BFF) or a PAT or CI token (CLI). */
  readonly getAuth: () => ApiAuth | Promise<ApiAuth>;
  /** Plain http, for local development and tests only. */
  readonly allowHttp?: boolean;
  readonly fetch?: typeof fetch;
  /** Per-attempt timeout in ms (default 10000). */
  readonly timeoutMs?: number;
  /** Retries after the first attempt (default 2). Only GET and POSTs that carry an Idempotency-Key retry. */
  readonly retries?: number;
  /** Backoff base in ms; attempt n waits base * 2^n (default 200). */
  readonly retryBaseDelayMs?: number;
  /** Validates 2xx bodies against the Zod contracts. Enable outside production. Default off. */
  readonly validateResponses?: boolean;
  /**
   * Called before each request. Returned headers are sent with it (for example a tracing hook). The hook
   * never sees the credential, and it cannot override the credential.
   */
  readonly onRequest?: (request: {
    readonly operationId: OperationId;
    readonly method: string;
    readonly url: string;
  }) => Readonly<Record<string, string>> | undefined;
}

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type Op<I extends OperationId> = operations[I];
type Responses<I extends OperationId> = Op<I>['responses'];
type ParameterGroup<I extends OperationId, K extends 'path' | 'query'> = NonNullable<
  Op<I>['parameters'][K]
>;

/** The JSON body of a content entry, or `never` when the entry has none. */
type JsonBody<R> = R extends { content?: infer C }
  ? [NonNullable<C>] extends [never]
    ? never
    : NonNullable<C> extends { 'application/json': infer B }
      ? B
      : never
  : never;

type RequestBodyOf<I extends OperationId> = 'requestBody' extends keyof Op<I>
  ? JsonBody<NonNullable<Op<I>['requestBody']>>
  : never;

type SuccessStatus = 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226;
type SuccessKeys<I extends OperationId> = Extract<keyof Responses<I>, SuccessStatus>;

/** The typed success body of an operation, across its 2xx statuses. */
export type OperationData<I extends OperationId> = {
  [S in SuccessKeys<I>]: JsonBody<Responses<I>[S]>;
}[SuccessKeys<I>];

/** The typed input of an operation: its path parameters, query and JSON body, where it has them. */
export type OperationInput<I extends OperationId> = Simplify<
  ([ParameterGroup<I, 'path'>] extends [never]
    ? { path?: never }
    : { path: ParameterGroup<I, 'path'> }) &
    ([ParameterGroup<I, 'query'>] extends [never]
      ? { query?: never }
      : { query?: ParameterGroup<I, 'query'> }) &
    ([RequestBodyOf<I>] extends [never] ? { body?: never } : { body: RequestBodyOf<I> })
>;

export interface ApiResponse<I extends OperationId> {
  readonly status: number;
  readonly headers: Headers;
  readonly data: OperationData<I>;
}

/** One typed method per `operationId` of the spec. */
export type ApiClient = {
  readonly [I in OperationId]: (
    input: OperationInput<I>,
    options?: RequestOptions,
  ) => Promise<ApiResponse<I>>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
/** Statuses that mean "try again later". Other 4xx and 5xx answers are final. */
const TOO_MANY_REQUESTS = 429;
const BAD_GATEWAY = 502;
const SERVICE_UNAVAILABLE = 503;
const GATEWAY_TIMEOUT = 504;
const RETRYABLE_STATUSES = new Set([
  TOO_MANY_REQUESTS,
  BAD_GATEWAY,
  SERVICE_UNAVAILABLE,
  GATEWAY_TIMEOUT,
]);
/** Headers that carry the credential. A caller may not set them per call. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie']);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

interface CallInput {
  readonly path?: Readonly<Record<string, unknown>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

/** Accepts only an origin over https (or http when `allowHttp`), with no path, query, or credentials. */
function normaliseBaseUrl(raw: string, allowHttp: boolean): string {
  const url = new URL(raw);
  const insecure = url.protocol === 'http:' && allowHttp;
  if (url.protocol !== 'https:' && !insecure) throw new TypeError('baseUrl must use https');
  if (
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new TypeError('baseUrl must be an origin without path, query or credentials');
  }
  return url.origin;
}

function buildUrl(
  base: string,
  path: string,
  pathParams: readonly string[],
  queryParams: readonly string[],
  input: CallInput,
): string {
  let resolved = path;
  for (const name of pathParams) {
    const value = input.path?.[name];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new TypeError(`missing path parameter ${name}`);
    }
    resolved = resolved.replace(`{${name}}`, encodeURIComponent(String(value)));
  }
  const url = new URL(`${base}${resolved}`);
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value === undefined) continue;
    if (!queryParams.includes(name)) throw new TypeError(`unknown query parameter ${name}`);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new TypeError(`query parameter ${name} must be a scalar`);
    }
    url.searchParams.append(name, String(value));
  }
  return url.toString();
}

function hasHeader(headers: Readonly<Record<string, string>> | undefined, name: string): boolean {
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name.toLowerCase());
}

/** Caller headers may not carry the credential, so auth always comes from `getAuth()`. */
function assertNoCredentialHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  for (const key of Object.keys(headers ?? {})) {
    if (CREDENTIAL_HEADERS.has(key.toLowerCase())) {
      throw new TypeError(`${key} cannot be set per request; use getAuth()`);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Turns a non-2xx body into a problem: the RFC 9457 body when it has one, otherwise a synthesised one. */
function problemFrom(text: string, status: number, statusText: string): Problem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const problem = problemSchema.safeParse(parsed);
  if (problem.success) return problem.data;
  return {
    type: 'about:blank',
    title: statusText === '' ? `HTTP ${String(status)}` : statusText,
    status,
    code: 'HTTP_ERROR',
    traceId: '',
  };
}

/**
 * Builds the typed control-plane client. Every method sends the spec's method and path, injects the
 * credential last, refuses redirects (no http downgrade), throws `ApiProblemError` for non-2xx answers,
 * and retries only idempotent requests.
 */
export function createApiClient(options: ApiClientOptions): ApiClient {
  const base = normaliseBaseUrl(options.baseUrl, options.allowHttp === true);
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;

  async function call(
    operationId: OperationId,
    input: CallInput,
    requestOptions: RequestOptions,
  ): Promise<{ status: number; headers: Headers; data: unknown }> {
    const meta = OPERATIONS[operationId];
    assertNoCredentialHeaders(requestOptions.headers);
    for (const header of meta.requiredHeaders) {
      if (!hasHeader(requestOptions.headers, header)) {
        throw new TypeError(`${operationId} requires the ${header} header`);
      }
    }
    const url = buildUrl(base, meta.path, meta.pathParams, meta.queryParams, input);
    const hasBody = input.body !== undefined;
    const retryable =
      IDEMPOTENT_METHODS.has(meta.method) || hasHeader(requestOptions.headers, 'Idempotency-Key');
    const extra = options.onRequest?.({ operationId, method: meta.method, url });

    for (let attempt = 0; ; attempt++) {
      const headers = new Headers({ accept: 'application/json' });
      if (hasBody) headers.set('content-type', 'application/json');
      if (requestOptions.traceparent !== undefined)
        headers.set('traceparent', requestOptions.traceparent);
      for (const [name, value] of Object.entries({ ...extra, ...requestOptions.headers })) {
        headers.set(name, value);
      }
      const auth = apiAuthSchema.safeParse(await options.getAuth());
      if (!auth.success) throw new TypeError('getAuth() must return a cookie or bearer credential');
      if (auth.data.kind === 'cookie') headers.set('cookie', auth.data.cookie);
      else headers.set('authorization', `Bearer ${auth.data.token}`);

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = requestOptions.signal
        ? AbortSignal.any([timeout, requestOptions.signal])
        : timeout;
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: meta.method,
          headers,
          ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
          redirect: 'error',
          signal,
        });
      } catch (error) {
        const kind = requestOptions.signal?.aborted
          ? 'aborted'
          : timeout.aborted
            ? 'timeout'
            : 'network';
        if (kind !== 'aborted' && retryable && attempt < retries) {
          await delay(retryBaseDelayMs * 2 ** attempt);
          continue;
        }
        throw new ApiNetworkError(kind, error);
      }

      if (RETRYABLE_STATUSES.has(response.status) && retryable && attempt < retries) {
        await response.body?.cancel();
        await delay(retryBaseDelayMs * 2 ** attempt);
        continue;
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw new ApiNetworkError(timeout.aborted ? 'timeout' : 'network', error);
      }
      if (!response.ok) {
        throw new ApiProblemError(problemFrom(text, response.status, response.statusText));
      }
      return {
        status: response.status,
        headers: response.headers,
        data: parseSuccess(operationId, response.status, text),
      };
    }
  }

  function parseSuccess(operationId: OperationId, status: number, text: string): unknown {
    if (text === '') return undefined;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiResponseError(operationId, status, ['$']);
    }
    if (!options.validateResponses) return data;
    const schema = RESPONSE_SCHEMAS[operationId][status];
    if (schema === undefined) return data;
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new ApiResponseError(
        operationId,
        status,
        parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '$'),
      );
    }
    // The wire shape is returned, not the parsed one: the typed output is the API view of the body.
    return data;
  }

  const methods = Object.fromEntries(
    (Object.keys(OPERATIONS) as OperationId[]).map((operationId) => [
      operationId,
      (input: CallInput, requestOptions: RequestOptions = {}) =>
        call(operationId, input, requestOptions),
    ]),
  );
  // The keys come from the generated OPERATIONS, so every method exists with the typed signature.
  return methods as unknown as ApiClient;
}
