import { lookup as resolveHost } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { TLSSocket } from 'node:tls';

import { SpanStatusCode, trace } from '@opentelemetry/api';

import {
  HTTP_CHALLENGE_PATH,
  type VerificationProbe,
  type VerificationProbeTarget,
  type VerificationProbeResult,
} from '@blackwing/domain';

import type { VerificationMethod } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';
import type { LookupAddress } from 'node:dns';
import type { ClientRequest, IncomingMessage } from 'node:http';

/**
 * The HTTP-file ownership probe (ASSET-006, CONTEXT_PACK §8.10). The customer serves the challenge token at
 * `https://<asset host>/.well-known/blackwing-verify.txt`; this probe fetches that exact URL and passes only when the
 * trimmed body equals the token.
 *
 * It is the `http_file` implementation of the framework port (ASSET-003) and runs in the control plane, never on the
 * sandbox egress path. Its fetch is hardened against the verifier being turned into an SSRF or rebinding primitive:
 * the host is resolved once and the TLS connection is pinned to that address; redirects are never followed (a 3xx is
 * a miss); the body is read through a byte cap; and the certificate must chain to the public trust store.
 *
 * Outcomes follow the port's contract. A definitive answer (wrong or missing token, 4xx, a redirect, a TLS failure,
 * an oversized body) is `not_found` with a short reason, which the framework counts as a miss. A transport failure,
 * a timeout, a 5xx answer or an unresolvable host throws, which the framework counts as `probe_error`. Either way the
 * asset is not verified, and the attempt is spent.
 */

/** `bw.asset.http.*` defaults (the issue's values). `maxRedirects` is fixed at 0 and has no setting. */
const HTTP_FILE_DEFAULTS = Object.freeze({
  timeoutMs: 5000,
  maxBytes: 4096,
});

/** Bounded reasons a run can answer with. They reach metrics and logs; never the token or the observed body. */
type HttpFileReason =
  | 'token_absent'
  | 'redirect_not_allowed'
  | 'tls_error'
  | 'unexpected_status'
  | 'unexpected_content_type'
  | 'body_too_large'
  | 'invalid_location'
  | 'token_found';

/** The per-run metric, by bounded result and reason. */
type HttpFileOutcomeRecorder = (
  result: 'passed' | 'not_found' | 'probe_error',
  reason: HttpFileReason | 'transport_error' | 'timeout' | 'server_error' | 'resolve_error',
) => void;

export interface HttpFileProbeOptions {
  /** Whole-request deadline in milliseconds (`bw.asset.http.timeoutMs`). */
  readonly timeoutMs?: number;
  /** Largest body read, in bytes (`bw.asset.http.maxBytes`). A longer body is treated as no match. */
  readonly maxBytes?: number;
  /** Resolves the host. Called exactly once per run; the connection is pinned to its answer. */
  readonly resolve?: (hostname: string) => Promise<LookupAddress>;
  /** TCP port of the fetch. 443 in production; a stub server port in tests. */
  readonly port?: number;
  /** Extra PEM trust anchors for tests. Production leaves it unset: the public trust store only. */
  readonly trustedCa?: string;
  readonly record?: HttpFileOutcomeRecorder;
  readonly logger?: Pick<Logger, 'info'>;
}

/** The fetch result the decision reads. Only what the decision needs: the status, the type and a capped body. */
interface FetchedFile {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly truncated: boolean;
  readonly subjectCn: string | undefined;
  readonly issuerCn: string | undefined;
}

/** A 5xx or a transport failure. Thrown, so the framework counts a `probe_error` (retryable, budget spent). */
class HttpFileTransientError extends Error {
  constructor(readonly reason: 'transport_error' | 'timeout' | 'server_error' | 'resolve_error') {
    super(reason);
    this.name = 'HttpFileTransientError';
  }
}

/** Node's TLS and certificate error codes: a chain or name that does not verify. */
const TLS_ERROR_CODE =
  /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED)/;

const UTF8_BOM = '\uFEFF';

/** The HTTPS port of the fetch (the challenge location carries no port). */
const HTTPS_PORT = 443;

/** Status-code boundaries: 2xx is a served file, 3xx a redirect (refused), 5xx a server error (retryable). */
const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;

/** The https URL the token must be served at, or `undefined` when the location is not the exact challenge location. */
function parseLocation(expectedLocation: string | null): URL | undefined {
  if (expectedLocation === null) return undefined;
  let url: URL;
  try {
    url = new URL(expectedLocation);
  } catch {
    return undefined;
  }
  const refused =
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== HTTP_CHALLENGE_PATH ||
    url.search !== '' ||
    url.hash !== '';
  return refused ? undefined : url;
}

/** Strips a UTF-8 byte order mark and surrounding whitespace, the only normalisation a token is compared through. */
export function normaliseTokenBody(body: string): string {
  return body.startsWith(UTF8_BOM) ? body.slice(UTF8_BOM.length).trim() : body.trim();
}

/** A `lookup` that always answers the pinned address (node's `https.request` calls it instead of DNS). */
function pinnedLookup(address: LookupAddress): RequestOptions['lookup'] {
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

function isTlsError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = error.code;
  return typeof code === 'string' && TLS_ERROR_CODE.test(code);
}

function commonName(name: unknown): string | undefined {
  if (typeof name !== 'object' || name === null || !('CN' in name)) return undefined;
  const cn = name.CN;
  return typeof cn === 'string' ? cn : undefined;
}

export class HttpFileProbe implements VerificationProbe {
  readonly method: VerificationMethod = 'http_file';

  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly resolve: (hostname: string) => Promise<LookupAddress>;
  private readonly port: number;
  private readonly trustedCa: string | undefined;
  private readonly record: HttpFileOutcomeRecorder;
  private readonly logger: Pick<Logger, 'info'> | undefined;

  constructor(options: HttpFileProbeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? HTTP_FILE_DEFAULTS.timeoutMs;
    this.maxBytes = options.maxBytes ?? HTTP_FILE_DEFAULTS.maxBytes;
    this.resolve = options.resolve ?? ((hostname) => resolveHost(hostname, { family: 0 }));
    this.port = options.port ?? HTTPS_PORT;
    this.trustedCa = options.trustedCa;
    this.record = options.record ?? (() => undefined);
    this.logger = options.logger;
  }

  /** One probe run, traced as `assets.verification.httpFile`. The token is compared and never recorded. */
  check(target: VerificationProbeTarget): Promise<VerificationProbeResult> {
    return trace
      .getTracer('@blackwing/api')
      .startActiveSpan('assets.verification.httpFile', async (span) => {
        try {
          return await this.run(target);
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
  }

  private async run(target: VerificationProbeTarget): Promise<VerificationProbeResult> {
    const location = parseLocation(target.expectedLocation);
    if (location === undefined) return this.answer('not_found', 'invalid_location');

    let file: FetchedFile;
    try {
      const address = await this.resolveOnce(location.hostname);
      file = await this.fetchOnce(location, address);
    } catch (error) {
      if (error instanceof HttpFileTransientError) {
        this.record('probe_error', error.reason);
        throw error;
      }
      if (isTlsError(error)) return this.answer('not_found', 'tls_error');
      this.record('probe_error', 'transport_error');
      throw new HttpFileTransientError('transport_error');
    }

    if (file.status >= HTTP_MULTIPLE_CHOICES && file.status < HTTP_BAD_REQUEST) {
      return this.answer('not_found', 'redirect_not_allowed');
    }
    if (file.status >= HTTP_SERVER_ERROR) {
      this.record('probe_error', 'server_error');
      throw new HttpFileTransientError('server_error');
    }
    if (file.status < HTTP_OK || file.status >= HTTP_MULTIPLE_CHOICES) {
      return this.answer('not_found', 'unexpected_status');
    }
    if (!file.contentType.toLowerCase().startsWith('text/')) {
      return this.answer('not_found', 'unexpected_content_type');
    }
    if (file.truncated) return this.answer('not_found', 'body_too_large');

    this.logger?.info(
      { host: location.hostname, subjectCn: file.subjectCn, issuerCn: file.issuerCn },
      'asset.verification_tls',
    );
    const served = normaliseTokenBody(file.body.toString('utf8'));
    if (served !== target.token) return this.answer('not_found', 'token_absent');
    return this.answer('passed', 'token_found');
  }

  private answer(outcome: 'passed' | 'not_found', reason: HttpFileReason): VerificationProbeResult {
    this.record(outcome === 'passed' ? 'passed' : 'not_found', reason);
    return outcome === 'passed' ? { outcome: 'passed' } : { outcome: 'not_found', reason };
  }

  /** The one resolution of the run. Its answer is the only address the connection may use. */
  private async resolveOnce(hostname: string): Promise<LookupAddress> {
    try {
      return await this.resolve(hostname);
    } catch {
      throw new HttpFileTransientError('resolve_error');
    }
  }

  /** One HTTPS GET to the pinned address, with the deadline, the byte cap and no redirect following. */
  private fetchOnce(location: URL, address: LookupAddress): Promise<FetchedFile> {
    return new Promise<FetchedFile>((resolve, reject) => {
      const request = httpsRequest(
        {
          host: location.hostname,
          servername: location.hostname,
          port: this.port,
          path: location.pathname,
          method: 'GET',
          headers: { Accept: 'text/plain' },
          // A fresh connection per run: no pooled socket carries one asset's verification into another.
          agent: false,
          lookup: pinnedLookup(address),
          rejectUnauthorized: true,
          ...(this.trustedCa === undefined ? {} : { ca: this.trustedCa }),
        },
        (response) => {
          this.readBody(response, resolve, reject, request);
        },
      );
      const deadline = setTimeout(() => {
        request.destroy(new HttpFileTransientError('timeout'));
      }, this.timeoutMs);
      request.on('close', () => {
        clearTimeout(deadline);
      });
      request.on('error', (error) => {
        reject(error);
      });
      request.end();
    });
  }

  /** Reads at most `maxBytes`, then stops. An over-long body resolves as `truncated` and is refused by the caller. */
  private readBody(
    response: IncomingMessage,
    resolve: (file: FetchedFile) => void,
    reject: (error: unknown) => void,
    request: ClientRequest,
  ): void {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    const socket = response.socket;
    const certificate = socket instanceof TLSSocket ? socket.getPeerCertificate() : undefined;
    const finish = (): void => {
      resolve({
        status: response.statusCode ?? 0,
        contentType: response.headers['content-type'] ?? '',
        body: Buffer.concat(chunks),
        truncated,
        subjectCn: commonName(certificate?.subject),
        issuerCn: commonName(certificate?.issuer),
      });
    };
    response.on('data', (chunk: Buffer) => {
      const room = this.maxBytes - total;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, Math.max(room, 0)));
        total = this.maxBytes;
        truncated = true;
        request.destroy();
        finish();
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    response.on('end', () => {
      if (!truncated) finish();
    });
    response.on('error', (error) => {
      reject(error);
    });
  }
}
