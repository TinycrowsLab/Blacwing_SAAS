import { z } from 'zod';

import { SECRET_RESOLVE_PATH } from '@blackwing/secrets';

/**
 * HTTP client of the internal secret resolve API (SECRETS-006): the only sanctioned read path for a
 * secret value. The session manager presents its service token and the tenant of the request; the
 * Secrets Service answers with the plaintext at the moment of use, with `cache-control: no-store`.
 *
 * Every failure is a {@link SecretFetchError} carrying only the registered error code from the response
 * body (or a local code). The response body, the reference and the value never reach an error message.
 */

const MAX_RESPONSE_BYTES = 65_536; // 64 KiB
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** A refused or failed resolve. `code` is a registered error code or one of the local codes below. */
export class SecretFetchError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`secret resolve failed: ${code}`);
    this.name = 'SecretFetchError';
    this.code = code;
  }
}

/** What the resolve API is asked. `runId` is required for the session manager (run-bound grant). */
export interface SecretFetchRequest {
  readonly tenantId: string;
  readonly secretRef: string;
  readonly callerPurpose: string;
  readonly runId: string;
  readonly context?: Readonly<Record<string, string>>;
  readonly traceId?: string;
}

export interface FetchedSecret {
  readonly value: string;
  readonly version: number;
  readonly type: string;
}

/** Fetches one secret value by reference. Rejects with {@link SecretFetchError} or any other error. */
export interface SecretFetcher {
  fetch(
    request: SecretFetchRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<FetchedSecret>;
}

export interface SecretsClientOptions {
  /** Origin of the Secrets Service internal listener, for example `http://secrets.internal:8080`. */
  readonly baseUrl: string;
  /** The session manager's service token (`bwsvc_…`). Read per call so rotation takes effect. */
  readonly serviceToken: () => string | Promise<string>;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const resolveResponseSchema = z.object({
  value: z.string().min(1),
  version: z.number().int().positive(),
  type: z.string().min(1),
});

const errorBodySchema = z.object({ code: z.string() });

async function refusalCode(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) return 'RESPONSE_TOO_LARGE';
    const parsed = errorBodySchema.safeParse(JSON.parse(text));
    return parsed.success && CODE.test(parsed.data.code)
      ? parsed.data.code
      : `HTTP_${String(response.status)}`;
  } catch {
    return `HTTP_${String(response.status)}`;
  }
}

export function createSecretsResolveClient(options: SecretsClientOptions): SecretFetcher {
  const url = new URL(SECRET_RESOLVE_PATH, options.baseUrl);
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async fetch(request, { signal }) {
      const token = await options.serviceToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-tenant-id': request.tenantId.toLowerCase(),
      };
      if (request.traceId !== undefined) headers['x-bw-trace-id'] = request.traceId;
      const body = {
        secretRef: request.secretRef,
        callerPurpose: request.callerPurpose,
        runId: request.runId,
        ...(request.context === undefined ? {} : { context: request.context }),
      };

      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
          redirect: 'error',
        });
      } catch {
        throw new SecretFetchError('UNREACHABLE');
      }
      if (!response.ok) throw new SecretFetchError(await refusalCode(response));

      let json: unknown;
      try {
        const text = await response.text();
        if (text.length > MAX_RESPONSE_BYTES) throw new SecretFetchError('RESPONSE_TOO_LARGE');
        json = JSON.parse(text);
      } catch (cause) {
        if (cause instanceof SecretFetchError) throw cause;
        throw new SecretFetchError('MALFORMED_RESPONSE');
      }
      const parsed = resolveResponseSchema.safeParse(json);
      if (!parsed.success) throw new SecretFetchError('MALFORMED_RESPONSE');
      return parsed.data;
    },
  };
}
