import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { AppError, ValidationError } from '@blackwing/errors';
import { createLogger } from '@blackwing/logger';
import { getMeter, withSpan } from '@blackwing/telemetry';

import {
  decryptRecord,
  generateSessionKeys,
  newCorrelationId,
  type OobSessionKeys,
  registrationPublicKey,
  unwrapAesKey,
} from './crypto.js';
import { type OobInteraction, toInteraction, wireInteractionSchema } from './interaction.js';
import {
  ENDPOINTS,
  INTERACTSH_PROTOCOL_VERSION,
  INTERACTSH_VERSION_HEADER,
  MAX_RECORDS_PER_POLL,
  MAX_RESPONSE_BYTES,
  NONCE_LENGTH,
  REQUEST_TIMEOUT_MS,
} from './protocol.js';

const log = createLogger('@blackwing/oob').child({ component: 'oob-client' });
const meter = getMeter('@blackwing/oob');
const pollCounter = meter.createCounter('oob_poll_total', {
  description: 'Out-of-band listener polls, by result (ok or error)',
});
const interactionCounter = meter.createCounter('oob_interactions_received_total', {
  description: 'Out-of-band interactions received and decrypted, by protocol',
});

/** Options for {@link OobClient}. The token and the domain come from `@blackwing/config` (OOB_SERVER_TOKEN, OOB_DOMAIN). */
export interface OobClientOptions {
  /** Base URL of the interactsh-server control API (OOB_SERVER_URL). */
  readonly serverUrl: string;
  /** The server's `-token`, sent as the `Authorization` header (OOB_SERVER_TOKEN). Never logged. */
  readonly token: string;
  /** Zone the server answers for (OOB_DOMAIN). Interaction hosts are `<correlationId><nonce>.<domain>`. */
  readonly domain: string;
  /** HTTP transport. Defaults to the global `fetch`; tests inject a double. */
  readonly fetch?: typeof fetch;
  /** This client's clock, stamped on `receivedAt`. Defaults to `Date.now`. */
  readonly now?: () => Date;
}

type ClientState = 'idle' | 'registering' | 'registered' | 'deregistered';
/** The error codes a control-API call can fail with. */
type TransportCode = 'OOB_REGISTER_FAILED' | 'OOB_POLL_FAILED' | 'OOB_DEREGISTER_FAILED';

const optionsSchema = z.object({
  serverUrl: z.url({ protocol: /^https?$/ }),
  token: z.string().min(1),
  domain: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i),
});

const NONCE_PATTERN = new RegExp(`^[a-z0-9]{${NONCE_LENGTH}}$`);

const pollResponseSchema = z.object({
  data: z.array(z.string()).nullish(),
  aes_key: z.string().optional(),
});

/**
 * A client for one interactsh correlation session (OOB-002, #636): it registers a fresh RSA public key and
 * correlation id with the listener, polls for AES-encrypted interaction batches, decrypts them and
 * deregisters. Keys live only in memory and die with the session. The client transports the listener's
 * deterministic signal and nothing more; judging an interaction is the validator's job (§8.11).
 *
 * Failures are typed `AppError`s (`OOB_REGISTER_FAILED`, `OOB_POLL_FAILED`, `OOB_DEREGISTER_FAILED`,
 * `OOB_DECRYPT_FAILED`, `OOB_PROTOCOL_INCOMPATIBLE`). A poll never returns an empty array on failure: the
 * caller must treat a thrown poll as "OOB unavailable", never as "no interaction".
 */
export class OobClient {
  readonly #base: string;
  readonly #token: string;
  readonly #domain: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #correlationId = newCorrelationId();
  readonly #secretKey = randomUUID();
  #state: ClientState = 'idle';
  #keys: OobSessionKeys | undefined;

  constructor(options: OobClientOptions) {
    const parsed = optionsSchema.safeParse({
      serverUrl: options.serverUrl,
      token: options.token,
      domain: options.domain,
    });
    if (!parsed.success) {
      throw new ValidationError('out-of-band client options are invalid', {
        detail: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
      });
    }
    this.#base = parsed.data.serverUrl.replace(/\/+$/, '');
    this.#token = parsed.data.token;
    this.#domain = parsed.data.domain.toLowerCase();
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  /** The correlation id this session registered (or will register). Public: it names the session, it is not a secret. */
  get correlationId(): string {
    return this.#correlationId;
  }

  /**
   * The interaction host for one test: `<correlationId><nonce>.<domain>`. The listener correlates only a
   * first label of exactly correlation id + 13-character nonce, so the per-test token (OOB-003) goes at the start
   * of the nonce. Lowercase DNS label characters only.
   */
  hostFor(nonce: string): string {
    if (!NONCE_PATTERN.test(nonce)) {
      throw new ValidationError('out-of-band nonce must be 13 lowercase alphanumeric characters', {
        detail: `nonce has ${nonce.length} characters or disallowed ones`,
      });
    }
    return `${this.#correlationId}${nonce}.${this.#domain}`;
  }

  /**
   * Verifies the listener speaks the pinned protocol version, then registers this session's public key,
   * correlation id and secret. Fails closed: a version mismatch is `OOB_PROTOCOL_INCOMPATIBLE`.
   */
  async register(): Promise<void> {
    if (this.#state !== 'idle') {
      throw new AppError('OOB_REGISTER_FAILED', 'out-of-band session already registered', {
        detail: `session state is ${this.#state}`,
      });
    }
    this.#state = 'registering';
    try {
      await this.#assertServerVersion();
      const keys = generateSessionKeys();
      await this.#send('OOB_REGISTER_FAILED', ENDPOINTS.register, {
        method: 'POST',
        authenticated: true,
        body: {
          'public-key': registrationPublicKey(keys.publicKey),
          'secret-key': this.#secretKey,
          'correlation-id': this.#correlationId,
        },
      });
      this.#keys = keys;
      this.#state = 'registered';
      log.info({ correlationId: this.#correlationId }, 'oob session registered');
    } catch (error) {
      this.#state = 'idle';
      throw error;
    }
  }

  /**
   * Polls the listener and returns the decrypted interactions for this session, oldest first as the
   * server returns them. Throws on any failure (unreachable listener, oversized batch, decrypt failure,
   * protocol mismatch). Interactions are returned at most once: the server clears a batch when it is served.
   */
  async poll(): Promise<OobInteraction[]> {
    const keys = this.#keys;
    if (this.#state !== 'registered' || keys === undefined) {
      throw new AppError('OOB_POLL_FAILED', 'out-of-band session is not registered', {
        detail: `session state is ${this.#state}`,
      });
    }
    return withSpan('oob.poll', async () => {
      try {
        const interactions = await this.#pollBatch(keys);
        pollCounter.add(1, { result: 'ok' });
        for (const interaction of interactions) {
          interactionCounter.add(1, { protocol: interaction.protocol });
        }
        log.info({ received: interactions.length }, 'oob poll completed');
        return interactions;
      } catch (error) {
        pollCounter.add(1, { result: 'error' });
        log.error(
          { code: error instanceof AppError ? error.code : 'INTERNAL' },
          'oob poll failed; OOB is unavailable for this session',
        );
        throw error;
      }
    });
  }

  /**
   * Stops this session: no further polls are served from this client, and its keys are dropped from
   * memory before the request is sent. If the listener cannot be reached the registration is left for the
   * server to evict, and the failure is reported as `OOB_DEREGISTER_FAILED`.
   */
  async deregister(): Promise<void> {
    if (this.#state !== 'registered') {
      this.#state = 'deregistered';
      this.#keys = undefined;
      return;
    }
    this.#state = 'deregistered';
    this.#keys = undefined;
    await this.#send('OOB_DEREGISTER_FAILED', ENDPOINTS.deregister, {
      method: 'POST',
      authenticated: true,
      body: { 'correlation-id': this.#correlationId, 'secret-key': this.#secretKey },
    });
    log.info({ correlationId: this.#correlationId }, 'oob session deregistered');
  }

  async #pollBatch(keys: OobSessionKeys): Promise<OobInteraction[]> {
    const text = await this.#send('OOB_POLL_FAILED', ENDPOINTS.poll, {
      method: 'GET',
      authenticated: true,
      query: { id: this.#correlationId, secret: this.#secretKey },
    });
    const body = parseJson(text, 'poll response');
    const parsed = pollResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw incompatible('poll response does not match the pinned protocol');
    }
    const records = parsed.data.data ?? [];
    if (records.length > MAX_RECORDS_PER_POLL) {
      throw new AppError('OOB_POLL_FAILED', 'out-of-band batch exceeds the per-poll cap', {
        detail: `batch of ${records.length} records exceeds ${MAX_RECORDS_PER_POLL}`,
      });
    }
    if (records.length === 0) return [];
    if (parsed.data.aes_key === undefined) {
      throw incompatible('poll response carries records but no aes_key');
    }
    const aesKey = unwrapAesKey(keys.privateKey, parsed.data.aes_key);
    const receivedAt = this.#now();
    return records.map((sealed) => {
      const plain = decryptRecord(aesKey, sealed);
      const json = parseJsonForDecrypt(plain);
      const wire = wireInteractionSchema.safeParse(json);
      if (!wire.success) {
        throw incompatible('decrypted record does not match the pinned protocol');
      }
      return toInteraction(wire.data, this.#correlationId, receivedAt);
    });
  }

  /** Fails closed unless the listener advertises exactly the pinned version. */
  async #assertServerVersion(): Promise<void> {
    const response = await this.#request('OOB_REGISTER_FAILED', ENDPOINTS.root, { method: 'GET' });
    const advertised = response.headers.get(INTERACTSH_VERSION_HEADER);
    if (advertised !== INTERACTSH_PROTOCOL_VERSION) {
      throw incompatible(
        `listener advertises ${advertised ?? 'no version'}, this client speaks ${INTERACTSH_PROTOCOL_VERSION}`,
      );
    }
  }

  /** One control-API call. Returns the bounded response body text. Never includes the URL or token in errors. */
  async #send(
    code: TransportCode,
    path: string,
    options: {
      method: 'GET' | 'POST';
      authenticated?: boolean;
      query?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<string> {
    const response = await this.#request(code, path, options);
    return readBounded(response, code);
  }

  async #request(
    code: TransportCode,
    path: string,
    options: {
      method: 'GET' | 'POST';
      authenticated?: boolean;
      query?: Record<string, string>;
      body?: unknown;
    },
  ): Promise<Response> {
    const url = new URL(`${this.#base}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(key, value);
    const headers: Record<string, string> = {};
    if (options.authenticated === true) headers.authorization = this.#token;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new AppError(code, 'out-of-band listener is unreachable', {
        detail: `request to ${path} failed before a response`,
        cause: error,
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(code, 'out-of-band listener refused the request', {
        detail: `${path} answered HTTP ${response.status}`,
      });
    }
    return response;
  }
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError('OOB_PROTOCOL_INCOMPATIBLE', 'out-of-band listener sent malformed JSON', {
      detail: `${what} is not JSON`,
      cause: error,
    });
  }
}

function parseJsonForDecrypt(plain: string): unknown {
  try {
    return JSON.parse(plain) as unknown;
  } catch (error) {
    // A wrong key decrypts to bytes that are not JSON: that is a decrypt failure, not a protocol one.
    throw new AppError('OOB_DECRYPT_FAILED', 'out-of-band interaction could not be decrypted', {
      detail: 'decrypted record is not JSON (key or protocol mismatch)',
      cause: error,
    });
  }
}

function incompatible(detail: string): AppError {
  return new AppError('OOB_PROTOCOL_INCOMPATIBLE', 'out-of-band listener protocol incompatible', {
    detail,
  });
}

/** Reads a response body, refusing anything over {@link MAX_RESPONSE_BYTES} (declared or actual). */
async function readBounded(response: Response, code: TransportCode): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new AppError(code, 'out-of-band listener response is too large', {
      detail: `declared ${declared} bytes exceeds ${MAX_RESPONSE_BYTES}`,
    });
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new AppError(code, 'out-of-band listener response is too large', {
      detail: `body exceeds ${MAX_RESPONSE_BYTES} bytes`,
    });
  }
  return text;
}
