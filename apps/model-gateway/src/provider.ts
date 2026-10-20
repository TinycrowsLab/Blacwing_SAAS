import type { ProviderId } from './config.js';

/** One upstream call. `body` is the raw JSON bytes the client sent, forwarded verbatim unless a model alias is resolved. */
export interface ProviderRequest {
  /** Path plus query string, e.g. `/v1/messages?beta=true`. */
  readonly pathAndQuery: string;
  /** Already filtered by `forwardRequestHeaders`; the adapter adds provider credentials. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** The `model` of the parsed request (alias or exact id). */
  readonly model: string;
}

/** Per-call context. */
export interface SendOptions {
  /** Aborted on client disconnect or timeout; the adapter must cancel the upstream request promptly. */
  readonly signal: AbortSignal;
  /** Tenant whose provider credential is resolved (GATEWAY-002 supplies it from the virtual key). */
  readonly tenantId?: string;
}

/** Upstream answer. `body` is consumed incrementally (never buffered whole), so SSE streams pass through. */
export interface ProviderResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: AsyncIterable<Uint8Array> | null;
}

export interface ProviderHealth {
  /** The upstream answered and accepted the credential. */
  readonly healthy: boolean;
  /** The upstream answered at all. */
  readonly reachable: boolean;
  /** Short, secret-free reason when not healthy. */
  readonly detail?: string;
}

/** Provider seam. GATEWAY-003..006 add the adapters (Anthropic, Bedrock, Vertex, Foundry). */
export interface ProviderAdapter {
  readonly name: ProviderId;
  /** Forwards one Messages request. Responses stream through; errors are normalised to Anthropic error JSON. */
  send(request: ProviderRequest, options: SendOptions): Promise<ProviderResponse>;
  /** Probes upstream reachability and credential acceptance. */
  healthCheck(): Promise<ProviderHealth>;
  /** Resolves an alias (or exact id) to the model id sent upstream. Exact ids pass through unchanged. */
  resolveModelId(aliasOrId: string): string;
  /** Readiness of this adapter (configuration valid). */
  ready(): boolean;
}
