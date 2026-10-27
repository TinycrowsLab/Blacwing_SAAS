import { Kind, parse, type SelectionSetNode } from 'graphql';
import { z } from 'zod';

import { ApiError, apiErrorFromResponse, CLIENT_ERROR_CODES, toNetworkError } from './api-error.js';
import { getPublicConfig, isGraphQLPersisted, isProductionBuild } from './config.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_BAD_REQUEST = 400;
const HTTP_CLIENT_ERROR_OK = 200;
const HEX_RADIX = 16;
/** Deepest selection nesting the console sends; mirrors the server cap (the API owns the authoritative value). */
export const GRAPHQL_MAX_DEPTH = 8;
/** Server error codes (`extensions.code`) the console handles itself. */
const GRAPHQL_CODES = {
  persistedNotFound: 'PERSISTED_QUERY_NOT_FOUND',
  complexityLimit: 'COMPLEXITY_LIMIT',
  depthLimit: 'DEPTH_LIMIT',
  failed: 'GRAPHQL_ERROR',
} as const;
/** Accepted shape of a server error code; anything else is replaced so arbitrary text never becomes `ApiError.code`. */
const SAFE_CODE = /^[A-Z][A-Z_]{0,63}$/;

/**
 * A query-only document type. The template literal makes a `mutation` or `subscription` literal a type error;
 * `defineQuery` also rejects them at runtime, so the check holds for untyped strings too.
 */
export type QueryText = `query ${string}`;

/** A named, read-only GraphQL operation with its result and variable types (no codegen: see the module note). */
export interface GraphQLQuery<TData, TVariables extends object = Record<string, never>> {
  readonly operationName: string;
  readonly text: string;
  /** Phantom carriers of the result and variable types; never set at runtime. */
  readonly __types?: { readonly data: TData; readonly variables: TVariables };
}

function selectionDepth(set: SelectionSetNode | undefined): number {
  if (set === undefined) return 0;
  let deepest = 0;
  for (const selection of set.selections) {
    const child = selection.kind === Kind.FRAGMENT_SPREAD ? undefined : selection.selectionSet;
    deepest = Math.max(deepest, 1 + selectionDepth(child));
  }
  return deepest;
}

/** Parses the document and returns its operation name, rejecting anything but one named query within the depth cap. */
function inspect(text: string): string {
  const { definitions } = parse(text);
  const [definition] = definitions;
  if (definitions.length !== 1 || definition?.kind !== Kind.OPERATION_DEFINITION) {
    throw new TypeError('A GraphQL document must hold exactly one operation');
  }
  if (definition.operation !== 'query' || definition.name === undefined) {
    throw new TypeError('Only named query operations can be sent; mutations stay on REST');
  }
  const depth = selectionDepth(definition.selectionSet);
  if (depth > GRAPHQL_MAX_DEPTH) {
    throw new TypeError(`Query nests ${depth} levels; the console limit is ${GRAPHQL_MAX_DEPTH}`);
  }
  return definition.name.value;
}

/**
 * The only way to create a GraphQL document in the console. Fails at module load on a syntax error, a
 * mutation or subscription, a missing name or a query deeper than `GRAPHQL_MAX_DEPTH`.
 */
export function defineQuery<TData, TVariables extends object = Record<string, never>>(
  text: QueryText,
): GraphQLQuery<TData, TVariables> {
  return { operationName: inspect(text), text };
}

interface GraphQLWarning {
  /** Server code of a field-level error that did not stop the result (for example a non-critical resolver). */
  readonly code: string;
}

/** `data` of a successful response; `warnings` are non-blocking problems the page may show. */
export interface GraphQLResult<TData> {
  readonly data: TData;
  readonly warnings: readonly GraphQLWarning[];
}

interface GraphQLRequestOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface GraphQLClient {
  request: <TData, TVariables extends object>(
    query: GraphQLQuery<TData, TVariables>,
    variables: TVariables,
    options?: GraphQLRequestOptions,
  ) => Promise<GraphQLResult<TData>>;
}

export interface GraphQLClientOptions {
  /** Same-origin path of the endpoint; defaults to `NEXT_PUBLIC_GRAPHQL_URL` (`/graphql`). */
  readonly url?: string;
  /** Send the persisted-query hash instead of the document; defaults to `NEXT_PUBLIC_GRAPHQL_PERSISTED`. */
  readonly persisted?: boolean;
  /** On `PERSISTED_QUERY_NOT_FOUND`, resend the full document once; defaults to on outside production. */
  readonly fallbackOnPersistedMiss?: boolean;
  /** Test seam; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const gqlErrorSchema = z.object({
  message: z.string(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});
const envelopeSchema = z.object({
  data: z.record(z.string(), z.unknown()).nullish(),
  errors: z.array(gqlErrorSchema).optional(),
});
type GqlError = z.infer<typeof gqlErrorSchema>;

/** Only same-origin relative paths, as for REST: a scheme or `//host` would send the session cookie elsewhere. */
function assertSameOriginPath(url: string): void {
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('\\') || url.includes('://')) {
    throw new TypeError('GraphQL URL must be a relative path starting with a single "/"');
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX_RADIX).padStart(2, '0'))
    .join('');
}

function safeCode(extensions: GqlError['extensions'], key: string): string | undefined {
  const value = extensions?.[key];
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
}

function serverCode(error: GqlError | undefined): string {
  return safeCode(error?.extensions, 'code') ?? GRAPHQL_CODES.failed;
}

/** Maps a GraphQL failure (no usable `data`) to the console's `ApiError`, keeping the codes the UI reacts to. */
function graphqlError(status: number, errors: readonly GqlError[], operation: string): ApiError {
  const first = errors[0];
  const code = serverCode(first);
  const traceId =
    typeof first?.extensions?.traceId === 'string' ? first.extensions.traceId : undefined;
  if (code === GRAPHQL_CODES.complexityLimit || code === GRAPHQL_CODES.depthLimit) {
    return new ApiError({
      status: HTTP_BAD_REQUEST,
      code: GRAPHQL_CODES.complexityLimit,
      title: 'Query too complex',
      detail: 'Narrow the filters (for example a shorter date range) and try again.',
      traceId,
      operation,
    });
  }
  return new ApiError({
    status: status >= HTTP_OK_MIN ? status : HTTP_CLIENT_ERROR_OK,
    code,
    title: 'GraphQL error',
    traceId,
    operation,
  });
}

interface Transport {
  readonly status: number;
  readonly text: string;
  readonly retryAfter: string | null;
}

/**
 * Typed read-only client for `/graphql` (CONSOLE-005 error model). Cookies carry the session, and each failure is
 * an `ApiError` tagged with the operation name. Only queries reach this function (see `defineQuery`).
 */
export function createGraphQLClient(options: GraphQLClientOptions = {}): GraphQLClient {
  const url = options.url ?? getPublicConfig().graphqlUrl;
  assertSameOriginPath(url);
  const persisted = options.persisted ?? isGraphQLPersisted();
  const fallbackOnMiss = options.fallbackOnPersistedMiss ?? !isProductionBuild();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch =
    options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));

  async function send(body: unknown, signal: AbortSignal | undefined): Promise<Transport> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      text = await response.text();
    } catch (cause) {
      // An unmount/navigation abort is not an error to report; only a timeout or transport failure is.
      if (signal?.aborted) throw cause;
      throw toNetworkError(timeout.aborted);
    }
    return { status: response.status, text, retryAfter: response.headers.get('Retry-After') };
  }

  /** One round trip; `persistedHash` set means send only the hash, otherwise the full document. */
  async function execute(
    query: GraphQLQuery<unknown, object>,
    variables: object,
    usePersisted: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Transport & { readonly envelope: z.infer<typeof envelopeSchema> | undefined }> {
    const base = { operationName: query.operationName, variables };
    const body = usePersisted
      ? {
          ...base,
          extensions: {
            persistedQuery: { version: 1, sha256Hash: await sha256Hex(query.text) },
          },
        }
      : { ...base, query: query.text };
    const transport = await send(body, signal);
    let json: unknown;
    try {
      json = JSON.parse(transport.text);
    } catch {
      json = undefined;
    }
    const parsed = envelopeSchema.safeParse(json);
    return { ...transport, envelope: parsed.success ? parsed.data : undefined };
  }

  function toResult<TData>(
    query: GraphQLQuery<TData, object>,
    transport: Transport & { readonly envelope: z.infer<typeof envelopeSchema> | undefined },
  ): GraphQLResult<TData> {
    const { envelope, status } = transport;
    const errors = envelope?.errors ?? [];
    const ok = status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;
    if (envelope?.data && ok) {
      return {
        // The server's contract for this operation is the typed `TData` the caller declared; the response
        // envelope itself is validated above, so the data field is trusted at this single boundary.
        data: envelope.data as TData,
        warnings: errors.map((error) => ({ code: serverCode(error) })),
      };
    }
    if (errors.length > 0) throw graphqlError(status, errors, query.operationName);
    if (!ok) {
      const error = apiErrorFromResponse(status, transport.text, transport.retryAfter);
      throw new ApiError({
        status: error.status,
        code: error.code,
        title: error.title,
        detail: error.detail,
        traceId: error.traceId,
        retryAfterMs: error.retryAfterMs,
        operation: query.operationName,
      });
    }
    throw new ApiError({
      status,
      code: CLIENT_ERROR_CODES.contractMismatch,
      title: 'Unexpected response',
      operation: query.operationName,
    });
  }

  return {
    async request(query, variables, request = {}) {
      const erased = query as GraphQLQuery<unknown, object>;
      const first = await execute(erased, variables, persisted, request.signal);
      const missed = (first.envelope?.errors ?? []).some(
        (error) => serverCode(error) === GRAPHQL_CODES.persistedNotFound,
      );
      // Dev only, and only once: a miss in production surfaces the error (CONTEXT_PACK §9 persisted queries).
      const transport =
        persisted && fallbackOnMiss && missed
          ? await execute(erased, variables, false, request.signal)
          : first;
      return toResult(query, transport);
    },
  };
}
