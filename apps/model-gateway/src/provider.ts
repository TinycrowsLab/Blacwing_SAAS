import type { ProviderId } from './config.js';

/** One upstream call. `body` is the raw JSON bytes the client sent, forwarded byte-for-byte. */
export interface ProviderRequest {
  /** Path plus query string, e.g. `/v1/messages?beta=true`. */
  readonly pathAndQuery: string;
  /** Already filtered by `forwardRequestHeaders`; the adapter adds provider credentials. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface SendOptions {
  /** Aborted on client disconnect or timeout; the adapter must cancel the upstream request promptly. */
  readonly signal: AbortSignal;
}

/** Upstream answer. `body` is consumed incrementally (never buffered whole), so SSE streams pass through. */
export interface ProviderResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: AsyncIterable<Uint8Array> | null;
}

/** Minimal provider seam. GATEWAY-003..006 add real adapters (Anthropic, Bedrock, Vertex, Foundry). */
export interface ProviderAdapter {
  readonly id: ProviderId;
  send(request: ProviderRequest, options: SendOptions): Promise<ProviderResponse>;
  /** Readiness of this adapter (credentials loaded, config valid). */
  ready(): boolean;
}

/** Source of the provider credential headers injected on every upstream request. */
export interface ProviderCredentials {
  headers(): Readonly<Record<string, string>>;
}

/**
 * Static credential source from gateway config.
 * OFFLINE-STUB(online-porting #884): dev/test inject an optional static key (the mock upstream needs none);
 * production provider credentials come from OpenBao per tenant/provider.
 */
export function staticAnthropicCredentials(apiKey: string | undefined): ProviderCredentials {
  const headers: Readonly<Record<string, string>> =
    apiKey === undefined ? {} : { 'x-api-key': apiKey };
  return { headers: () => headers };
}

export interface AnthropicStubAdapterOptions {
  readonly baseUrl: string;
  readonly credentials: ProviderCredentials;
  /** Injected for tests; defaults to the global `fetch` (undici). */
  readonly fetch?: typeof fetch;
}

/**
 * The single default provider of GATEWAY-001: a plain streaming passthrough to an Anthropic-compatible
 * base URL. GATEWAY-003 replaces it with the full Anthropic adapter.
 */
export class AnthropicStubAdapter implements ProviderAdapter {
  readonly id = 'anthropic' as const;
  readonly #base: URL;
  readonly #credentials: ProviderCredentials;
  readonly #fetch: typeof fetch;

  constructor(options: AnthropicStubAdapterOptions) {
    this.#base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? fetch;
  }

  ready(): boolean {
    return true;
  }

  async send(request: ProviderRequest, options: SendOptions): Promise<ProviderResponse> {
    const url = new URL(request.pathAndQuery.replace(/^\/+/, ''), this.#base);
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(this.#credentials.headers())) {
      headers.set(name, value);
    }
    const response = await this.#fetch(url, {
      method: 'POST',
      headers,
      body: request.body,
      signal: options.signal,
      redirect: 'manual',
    });
    return { status: response.status, headers: response.headers, body: response.body };
  }
}
