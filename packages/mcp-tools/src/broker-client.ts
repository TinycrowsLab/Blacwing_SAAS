import { BROKER_BASE_PATH } from '@blackwing/contracts';

import { ToolError } from './errors.js';

import type { z } from 'zod';

/**
 * The single run-scoped client every tool uses to reach a backend (CONTEXT_PACK §4.1, §8.11). Tools have no
 * other network path: the sandbox only reaches the Run Broker, and the broker enforces scope and tenancy.
 */
export interface BrokerClient {
  /** `GET /internal/broker/runs/{runId}/{suffix}`; the body is parsed with `schema`. */
  get<T>(suffix: string, schema: z.ZodType<T>): Promise<T>;
  /** `POST /internal/broker/runs/{runId}/{suffix}`; resolves `undefined` for an empty response. */
  post<T = undefined>(
    suffix: string,
    body: unknown,
    schema?: z.ZodType<T>,
    /** `idempotencyKey` is sent as the `Idempotency-Key` header: a retry with the same key must not repeat a write (§9). */
    options?: { readonly idempotencyKey?: string },
  ): Promise<T>;
}

export interface BrokerClientOptions {
  /** Origin of the Run Broker, e.g. `http://run-broker.internal:8080`. */
  readonly baseUrl: string;
  readonly runId: string;
  /** The short-lived `bwrun_` token. Held in this closure only; never logged, never put in an error. */
  readonly token: string;
  /** Per-request budget; exceeding it is `TOOL_BACKEND_UNAVAILABLE`. Default 10 s. */
  readonly timeoutMs?: number;
  /** Session kill signal: aborting it makes in-flight and later requests fail with `TOOL_KILLED`. */
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/** One path segment (`gate2` included), or a UUID segment (`engagement/subtasks/<id>/result`). */
const SUFFIX = /^[a-z][a-z0-9-]{0,31}(?:\/(?:[a-z][a-z0-9-]{0,31}|[0-9a-f-]{36}))*$/;
const RUN_ID = /^[0-9a-f-]{36}$/;

/** The problem+json `code` of a failed broker response, if it has one. */
async function problemCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'code' in body) {
      return typeof body.code === 'string' ? body.code : undefined;
    }
  } catch {
    // Not JSON: the status alone decides.
  }
  return undefined;
}

export function createBrokerClient(options: BrokerClientOptions): BrokerClient {
  const base = new URL(options.baseUrl);
  if (
    (base.protocol !== 'http:' && base.protocol !== 'https:') ||
    base.username !== '' ||
    base.password !== ''
  ) {
    throw new TypeError('broker baseUrl must be an http(s) URL without credentials');
  }
  if (!RUN_ID.test(options.runId)) throw new TypeError('broker runId must be a UUID');
  if (options.token === '') throw new TypeError('broker token is required');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killed = (): boolean => options.signal?.aborted === true;

  const call = async <T>(
    method: 'GET' | 'POST',
    suffix: string,
    body: unknown,
    schema: z.ZodType<T> | undefined,
    idempotencyKey?: string,
  ): Promise<T> => {
    if (!SUFFIX.test(suffix)) throw new TypeError('invalid broker path');
    if (killed()) throw new ToolError('TOOL_KILLED', 'the run was killed');
    const url = new URL(`${BROKER_BASE_PATH}/runs/${options.runId}/${suffix}`, base);
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal !== undefined) signals.push(options.signal);
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A redirect would replay the bearer token to another origin.
        redirect: 'error',
        signal: AbortSignal.any(signals),
      });
    } catch {
      if (killed()) throw new ToolError('TOOL_KILLED', 'the run was killed');
      throw new ToolError('TOOL_BACKEND_UNAVAILABLE', 'the run broker is unreachable');
    }
    if (!response.ok) {
      if (response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN) {
        throw new ToolError('TOOL_SCOPE_DENIED', 'the run token does not permit this call');
      }
      const code = await problemCode(response);
      if (code === 'RUN_NOT_ACTIVE') {
        throw new ToolError('TOOL_KILLED', 'the run is no longer active');
      }
      if (code === 'INVALID_TRANSITION') {
        throw new ToolError('TOOL_INVALID_INPUT', 'the status change is not allowed');
      }
      throw new ToolError(
        'TOOL_BACKEND_UNAVAILABLE',
        `the run broker answered ${String(response.status)}`,
      );
    }
    try {
      const text = await response.text();
      if (text === '') return undefined as T;
      const parsed: unknown = JSON.parse(text);
      return schema === undefined ? (parsed as T) : schema.parse(parsed);
    } catch {
      throw new ToolError('TOOL_BACKEND_UNAVAILABLE', 'the run broker sent an invalid response');
    }
  };

  return {
    get: (suffix, schema) => call('GET', suffix, undefined, schema),
    post: (suffix, body, schema, options) =>
      call('POST', suffix, body ?? {}, schema, options?.idempotencyKey),
  };
}
