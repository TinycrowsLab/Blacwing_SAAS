import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

import { AppError } from '@blackwing/errors';

import type { RedactionRegistry } from './redaction.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Internal Run Broker endpoint `/internal/runs/{runId}/redaction` (SECRETS-007, §8.6, §9).
 *
 *  - `GET`    sizes and hit counts only; literals are never returned.
 *  - `POST`   `{op:'register'|'rotate'|'remove'|'redact', ...}`; `redact` takes `{text}` and answers
 *             `{text, hits, truncated}`, so consumers send text to the registry instead of pulling literals.
 *  - `DELETE` purges the run's registry (the KILL path).
 *
 * Access: the run-scoped bearer token (HMAC of tenant and run under a platform key, so a token for
 * run A never opens run B) and a peer on a private or loopback address. The network policy keeping
 * the listener off the public side is the primary control; the peer check fails closed behind it.
 */

const KIB = 1024;
const MAX_BODY_MIB = 8;
const MAX_BODY_BYTES = MAX_BODY_MIB * KIB * KIB;
const BEARER_PREFIX = 'Bearer ';
const OK = 200;
const NO_CONTENT = 204;
const BAD_REQUEST = 400;
const UNAUTHENTICATED = 401;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const METHOD_NOT_ALLOWED = 405;
const SERVER_ERROR = 500;
const INTERNAL_V4 = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
const INTERNAL_V6 = /^(?:::1$|f[cd]|fe[89ab])/;
const V4_MAPPED = /^::ffff:/i;
const RUN_PATH = /^\/internal\/runs\/([a-z0-9][a-z0-9_-]{0,127})\/redaction$/;

export interface RedactionHandlerDeps {
  readonly registry: RedactionRegistry;
  /** Platform secret from which run tokens derive; never logged. */
  readonly tokenKey: Buffer | string;
}

/** The token the Run Broker hands the run's trusted components. */
export function redactionRunToken(
  tokenKey: Buffer | string,
  tenantId: string,
  runId: string,
): string {
  return createHmac('sha256', tokenKey).update(`redaction\0${tenantId}\0${runId}`).digest('hex');
}

/** RFC1918, loopback, link-local and ULA peers; anything else (or unknown) is external. */
export function isInternalAddress(addr: string | undefined): boolean {
  if (addr === undefined) return false;
  const a = addr.replace(V4_MAPPED, '');
  if (isIPv4(a)) return INTERNAL_V4.test(a);
  return isIPv6(a) && INTERNAL_V6.test(a.toLowerCase());
}

function send(res: ServerResponse, status: number, body: unknown): undefined {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(json);
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) throw new AppError('VALIDATION_FAILED', 'request body too large');
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('VALIDATION_FAILED', 'request body is not JSON');
  }
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'string') throw new AppError('VALIDATION_FAILED', `${field} must be a string`);
  return v;
};

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createRedactionHandler(deps: RedactionHandlerDeps) {
  const { registry, tokenKey } = deps;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const runId = RUN_PATH.exec((req.url ?? '').split('?')[0] ?? '')?.[1];
    if (runId === undefined) {
      send(res, NOT_FOUND, { error: 'not_found' });
      return;
    }
    if (!isInternalAddress(req.socket.remoteAddress)) {
      send(res, FORBIDDEN, { error: 'forbidden' });
      return;
    }
    const tenantId = req.headers['x-tenant-id'];
    const auth = req.headers.authorization;
    if (
      typeof tenantId !== 'string' ||
      typeof auth !== 'string' ||
      !auth.startsWith(BEARER_PREFIX)
    ) {
      send(res, UNAUTHENTICATED, { error: 'unauthenticated' });
      return;
    }
    let expected: string;
    try {
      expected = redactionRunToken(tokenKey, tenantId, runId);
    } catch {
      send(res, UNAUTHENTICATED, { error: 'unauthenticated' });
      return;
    }
    if (!tokenMatches(auth.slice(BEARER_PREFIX.length), expected)) {
      send(res, UNAUTHENTICATED, { error: 'unauthenticated' });
      return;
    }

    try {
      if (req.method === 'GET') {
        send(res, OK, {
          exists: registry.has(tenantId, runId),
          size: registry.size(tenantId, runId),
        });
        return;
      }
      if (req.method === 'DELETE') {
        await registry.purge(tenantId, runId);
        send(res, NO_CONTENT, {});
        return;
      }
      if (req.method !== 'POST') {
        send(res, METHOD_NOT_ALLOWED, { error: 'method_not_allowed' });
        return;
      }
      const body = (await readJson(req)) as Record<string, unknown> | null;
      if (body === null || typeof body !== 'object') {
        throw new AppError('VALIDATION_FAILED', 'body must be an object');
      }
      switch (body.op) {
        case 'register':
        case 'rotate': {
          const input = {
            label: str(body.label, 'label'),
            value: str(body.value, 'value'),
            highValue: body.highValue === true,
          };
          const r =
            body.op === 'register'
              ? await registry.register(tenantId, runId, input)
              : await registry.rotate(tenantId, runId, input);
          send(res, OK, r);
          return;
        }
        case 'remove':
          registry.remove(tenantId, runId, str(body.label, 'label'));
          {
            send(res, OK, { size: registry.size(tenantId, runId) });
            return;
          }
        case 'redact': {
          send(res, OK, registry.redact(tenantId, runId, str(body.text, 'text')));
          return;
        }
        default:
          throw new AppError('VALIDATION_FAILED', 'unknown op');
      }
    } catch (err) {
      // Messages are ours and never contain submitted values; anything else is a bare 500.
      if (err instanceof AppError && err.code === 'VALIDATION_FAILED') {
        send(res, BAD_REQUEST, { error: 'validation_failed', message: err.message });
        return;
      }
      send(res, SERVER_ERROR, { error: 'internal' });
      return;
    }
  };
}
