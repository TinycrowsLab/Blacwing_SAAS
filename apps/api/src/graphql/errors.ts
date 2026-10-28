import { HttpException } from '@nestjs/common';
import {
  GraphQLError as GraphQLErrorClass,
  type ExecutionResult,
  type GraphQLError,
  type GraphQLFormattedError,
} from 'graphql';

import { isAppError, UNKNOWN_TRACE_ID } from '@blackwing/errors';
import { redactText } from '@blackwing/logger';

import { QUERY_TOO_COMPLEX } from './limits.js';
import { currentTraceId } from '../bootstrap/request-context.js';
import { wireCodeForStatus } from '../errors/problem-filter.js';
import { problemRegistry, type ProblemRegistry, wireCodeFor } from '../errors/registry.js';

const STATUS_SERVER_ERROR = 500;
const STATUS_OK = 200;
const INTERNAL_CODE = 'internal_error';
const VALIDATION_CODE = 'validation_failed';

/** Registers the GraphQL-only wire code in the REST problem registry, so both transports share one code list. */
export function registerGraphqlProblemCodes(registry: ProblemRegistry = problemRegistry): void {
  registry.register(QUERY_TOO_COMPLEX, { status: 400, title: 'Query too complex' });
}

interface Described {
  readonly code: string;
  readonly message: string;
}

/**
 * The stable code and the caller-safe message of one GraphQL error (API-009). `AppError`s and HTTP
 * exceptions keep their registry code; a server-side (5xx) message is replaced by the registry title, so
 * no internals leak. Any other thrown value is `internal_error`. Stacks are never rendered.
 */
function describe(error: GraphQLError, registry: ProblemRegistry): Described {
  const original: unknown = error.originalError;
  if (original === undefined || original === null) {
    const preset: unknown = error.extensions.code;
    return {
      code: typeof preset === 'string' ? preset : VALIDATION_CODE,
      message: error.message,
    };
  }
  if (isAppError(original)) {
    const { code, entry } = registry.resolve(wireCodeFor(original.code));
    return {
      code,
      message: entry.status < STATUS_SERVER_ERROR ? redactText(original.message) : entry.title,
    };
  }
  if (original instanceof HttpException) {
    const { code, entry } = registry.resolve(wireCodeForStatus(original.getStatus()));
    return {
      code,
      message: entry.status < STATUS_SERVER_ERROR ? redactText(original.message) : entry.title,
    };
  }
  const fallback = registry.resolve(INTERNAL_CODE);
  return { code: fallback.code, message: fallback.entry.title };
}

/**
 * A validation failure reaches the formatter wrapped by Mercurius, which keeps the rule and syntax errors in
 * `originalError.errors`. They are unwrapped here so each keeps its own code and location.
 */
function unwrapValidation(error: GraphQLError): readonly GraphQLError[] {
  const nested: unknown = (error.originalError as { readonly errors?: unknown } | null | undefined)
    ?.errors;
  if (!Array.isArray(nested) || nested.length === 0) return [error];
  return nested.map((item: unknown) =>
    item instanceof GraphQLErrorClass
      ? item
      : new GraphQLErrorClass(item instanceof Error ? item.message : String(item)),
  );
}

/**
 * Renders GraphQL errors as `errors[]` items whose `extensions.code` mirrors the REST registry (API-009).
 * A partial failure keeps `data` and lists its errors per spec; the HTTP status stays 200 because GraphQL
 * reports failures in the body. Unauthenticated access is `extensions.code: unauthenticated`.
 */
export function formatGraphqlErrors(
  execution: ExecutionResult & { readonly errors: readonly GraphQLError[] },
  registry: ProblemRegistry = problemRegistry,
): {
  readonly statusCode: typeof STATUS_OK;
  readonly response: {
    readonly data: NonNullable<ExecutionResult['data']> | null;
    readonly errors: GraphQLFormattedError[];
  };
} {
  const traceId = currentTraceId() ?? UNKNOWN_TRACE_ID;
  return {
    statusCode: STATUS_OK,
    response: {
      data: execution.data ?? null,
      errors: execution.errors
        .flatMap((error) => unwrapValidation(error))
        .map((error) => {
          const { code, message } = describe(error, registry);
          return {
            message,
            ...(error.locations === undefined ? {} : { locations: error.locations }),
            ...(error.path === undefined ? {} : { path: error.path }),
            extensions: { code, traceId },
          };
        }),
    },
  };
}
