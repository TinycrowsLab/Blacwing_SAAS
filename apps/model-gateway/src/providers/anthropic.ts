import Anthropic from '@anthropic-ai/sdk';
import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import { anthropicErrorBodySchema } from '@blackwing/contracts';

import { anthropicError, errorTypeForStatus } from '../anthropic-error.js';
import { HTTP_STATUS } from '../http-status.js';
import { type ResolveProviderCredential, requireApiKey } from './credentials.js';
import { ProviderError } from './errors.js';

import type { ProviderId } from '../config.js';
import type { GatewayMetrics } from '../metrics.js';
import type {
  ProviderAdapter,
  ProviderHealth,
  ProviderRequest,
  ProviderResponse,
  SendOptions,
} from '../provider.js';
import type { Logger } from '@blackwing/logger';

const TRACER_NAME = '@blackwing/model-gateway';
const HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_ANTHROPIC_VERSION_HEADER = '2023-06-01';

/** Coarse record of one provider call (§8.8): provider, outcome, tenant. Never bodies or credentials. */
export interface ProviderCallAuditEvent {
  readonly action: 'provider.call';
  readonly provider: ProviderId;
  readonly outcome: 'success' | 'upstream_error' | 'error';
  readonly tenantId: string | undefined;
}

export interface AnthropicAdapterOptions {
  /** Anthropic API base URL (https://api.anthropic.com in production; a local mock offline). */
  readonly baseUrl: string;
  /** Per-tenant credential lookup; GATEWAY-007 supplies the OpenBao-backed one. */
  readonly resolveCredential: ResolveProviderCredential;
  /** Alias to exact-model-id map. GATEWAY-008 owns the allowlist; unknown ids always pass through. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Upstream request timeout; omitted means the SDK default. The gateway server enforces its own deadline too. */
  readonly requestTimeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly logger?: Logger;
  readonly metrics?: GatewayMetrics;
  readonly tracer?: Tracer;
  readonly audit?: (event: ProviderCallAuditEvent) => void;
}

const encoder = new TextEncoder();

function jsonResponse(
  status: number,
  body: unknown,
  extra: Readonly<Record<string, string>> = {},
): ProviderResponse {
  const bytes = encoder.encode(JSON.stringify(body));
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json', ...extra }),
    body: (async function* (): AsyncGenerator<Uint8Array> {
      await Promise.resolve();
      yield bytes;
    })(),
  };
}

/** SSE `error` event, the shape Anthropic itself uses for a failure after the stream started. */
function sseErrorEvent(): Uint8Array {
  const data = JSON.stringify(anthropicError('api_error', 'Upstream stream failed.'));
  return encoder.encode(`event: error\ndata: ${data}\n\n`);
}

/**
 * Official-SDK Anthropic adapter (GATEWAY-003). Streams are never buffered. SDK retries are off:
 * retry policy belongs to GATEWAY-015.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic' as const;
  readonly #base: string;
  readonly #options: AnthropicAdapterOptions;
  readonly #fetch: typeof fetch;
  readonly #tracer: Tracer;

  constructor(options: AnthropicAdapterOptions) {
    this.#options = options;
    this.#base = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#tracer = options.tracer ?? trace.getTracer(TRACER_NAME);
  }

  ready(): boolean {
    return true;
  }

  /** Alias resolution only; exact Claude ids (no date-suffix rewriting) pass through unchanged (§4.6). */
  resolveModelId(aliasOrId: string): string {
    const aliases = this.#options.aliases;
    if (aliases !== undefined && Object.hasOwn(aliases, aliasOrId)) {
      return aliases[aliasOrId] ?? aliasOrId;
    }
    return aliasOrId;
  }

  async send(request: ProviderRequest, options: SendOptions): Promise<ProviderResponse> {
    const started = performance.now();
    const span = this.#tracer.startSpan('gw.provider.anthropic');
    const finish = (status: string, outcome: ProviderCallAuditEvent['outcome']): void => {
      this.#options.metrics?.providerRequests.inc({ provider: this.name, status });
      this.#options.metrics?.providerLatency.observe(
        { provider: this.name },
        Math.round(performance.now() - started),
      );
      this.#options.audit?.({
        action: 'provider.call',
        provider: this.name,
        outcome,
        tenantId: options.tenantId,
      });
      span.setAttribute('gw.provider.status', status);
      span.end();
    };

    try {
      const apiKey = requireApiKey(await this.#options.resolveCredential(options.tenantId));
      const model = this.resolveModelId(request.model);
      if (!model.startsWith('claude-')) {
        this.#options.logger?.info({ model }, 'gw.provider.unknown_model_passed_upstream');
      }
      const client = new Anthropic({
        apiKey,
        baseURL: this.#base,
        maxRetries: 0,
        ...(this.#options.requestTimeoutMs === undefined
          ? {}
          : { timeout: this.#options.requestTimeoutMs }),
        fetch: this.#fetch,
      });
      const response = await client
        .post(request.pathAndQuery, {
          body: model === request.model ? request.body : rewriteModel(request.body, model),
          headers: { ...request.headers, 'content-type': 'application/json' },
          signal: options.signal,
        })
        .asResponse();
      finish(String(response.status), 'success');
      return {
        status: response.status,
        headers: response.headers,
        body: response.body === null ? null : this.#guardStream(response.body, options.signal),
      };
    } catch (error) {
      return this.#normaliseError(error, options.signal, finish, span);
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    let apiKey: string;
    try {
      apiKey = requireApiKey(await this.#options.resolveCredential(undefined));
    } catch (error) {
      return {
        healthy: false,
        reachable: false,
        detail: error instanceof ProviderError ? error.code : 'credential_unavailable',
      };
    }
    try {
      const response = await this.#fetch(`${this.#base}/v1/models?limit=1`, {
        headers: { 'x-api-key': apiKey, 'anthropic-version': DEFAULT_ANTHROPIC_VERSION_HEADER },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        redirect: 'manual',
      });
      await response.body?.cancel();
      if (response.status === HTTP_STATUS.unauthorized) {
        return { healthy: false, reachable: true, detail: 'PROVIDER_AUTH_FAILED' };
      }
      return response.status >= HTTP_STATUS.internalError
        ? { healthy: false, reachable: true, detail: `upstream_${String(response.status)}` }
        : { healthy: true, reachable: true };
    } catch {
      return { healthy: false, reachable: false, detail: 'unreachable' };
    }
  }

  /** On a mid-stream failure, ends the stream with an Anthropic `error` event instead of a bare cut-off. */
  async *#guardStream(
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): AsyncGenerator<Uint8Array> {
    try {
      yield* body;
    } catch (error) {
      if (signal.aborted) throw error;
      this.#options.logger?.warn(
        { err: error instanceof Error ? error.name : 'unknown' },
        'gw.provider.stream_failed',
      );
      yield sseErrorEvent();
    }
  }

  #normaliseError(
    error: unknown,
    signal: AbortSignal,
    finish: (status: string, outcome: ProviderCallAuditEvent['outcome']) => void,
    span: { setStatus: (s: { code: SpanStatusCode; message: string }) => void },
  ): ProviderResponse {
    if (error instanceof ProviderError) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.code });
      finish(error.code, 'error');
      throw error;
    }
    if (signal.aborted || error instanceof Anthropic.APIUserAbortError) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'aborted' });
      finish('aborted', 'error');
      throw error;
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'PROVIDER_TIMEOUT' });
      finish('PROVIDER_TIMEOUT', 'error');
      throw new ProviderError({
        code: 'PROVIDER_TIMEOUT',
        httpStatus: HTTP_STATUS.gatewayTimeout,
        errorType: 'timeout_error',
        message: 'Upstream provider did not respond in time.',
        retryable: true,
      });
    }
    if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
      return this.#upstreamError(
        { error: error.error as unknown, headers: error.headers as Headers | undefined },
        error.status,
        finish,
        span,
      );
    }
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'unreachable' });
    finish('unreachable', 'error');
    throw error;
  }

  #upstreamError(
    error: { readonly error: unknown; readonly headers: Headers | undefined },
    status: number,
    finish: (status: string, outcome: ProviderCallAuditEvent['outcome']) => void,
    span: { setStatus: (s: { code: SpanStatusCode; message: string }) => void },
  ): ProviderResponse {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(status) });
    if (status === HTTP_STATUS.unauthorized) {
      finish('PROVIDER_AUTH_FAILED', 'upstream_error');
      this.#options.logger?.error({ upstreamStatus: status }, 'gw.provider.auth_failed');
      // The gateway's credential was rejected: a gateway/tenant-config failure, not the client's.
      return jsonResponse(
        HTTP_STATUS.badGateway,
        anthropicError(
          'api_error',
          'PROVIDER_AUTH_FAILED: the upstream provider rejected the configured credential.',
        ),
      );
    }
    finish(String(status), 'upstream_error');
    const parsed = anthropicErrorBodySchema.safeParse(error.error);
    const body = parsed.success
      ? parsed.data
      : anthropicError(errorTypeForStatus(status), 'Upstream provider returned an error.');
    const retryAfter = error.headers?.get('retry-after');
    return jsonResponse(
      status,
      body,
      retryAfter === null || retryAfter === undefined ? {} : { 'retry-after': retryAfter },
    );
  }
}

function rewriteModel(body: Uint8Array, model: string): Uint8Array {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  if (typeof parsed !== 'object' || parsed === null) return body;
  return encoder.encode(JSON.stringify({ ...parsed, model }));
}
