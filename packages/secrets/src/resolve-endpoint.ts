import { BlockList, isIP } from 'node:net';

import { z } from 'zod';

import { uuidV7Schema } from '@blackwing/contracts';
import { AppError, ERROR_CODES, isAppError, type ErrorCode } from '@blackwing/errors';

import type { ResolveMetrics, SecretResolver } from './resolve.js';
import type { ServiceTokenVerifier } from './service-auth.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * `POST /internal/secrets/resolve` (SECRETS-006, F35, §8.6, §8.7, §9): the only way a platform service
 * reads a secret value. It is served on the internal listener only, never on the public ingress and never
 * on the Run Broker listener the sandbox reaches (see docs/runbooks/secrets-resolve.md).
 *
 * Defence in depth around the NetworkPolicy, all fail-closed:
 *  1. the socket peer must be inside `allowedPeerCidrs` (the callers' pod CIDRs, NOT the sandbox CIDR);
 *     `X-Forwarded-For` is never read and an empty allowlist refuses everything;
 *  2. the caller presents a signed service token (`SERVICE_AUTH_FAILED` otherwise);
 *  3. the resolver applies tenant match, the per-service matrix, run state and audit (`resolve.ts`).
 *
 * Responses carry `cache-control: no-store`. The value appears only in a 200 body; error bodies carry the
 * registered code and title and never an input or a message.
 */

const KIB = 1024;
const MAX_BODY_KIB = 16;
const MAX_BODY_BYTES = MAX_BODY_KIB * KIB;
const OK = 200;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const METHOD_NOT_ALLOWED = 405;
const IPV4 = 4;
const IPV4_BITS = 32;
const IPV6_BITS = 128;
const MAX_CONTEXT_KEYS = 16;
const MAX_CONTEXT_KEY = 64;
const MAX_CONTEXT_VALUE = 256;
const MAX_REF = 256;
const MAX_PURPOSE = 64;

export const SECRET_RESOLVE_PATH = '/internal/secrets/resolve';
const TENANT_HEADER = 'x-tenant-id';
const TRACE_HEADER = 'x-bw-trace-id';

const V4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACE = /^(?!0{32})[0-9a-f]{32}$/;

/** The request body of the resolve call. */
export const resolveRequestSchema = z.strictObject({
  secretRef: z.string().min(1).max(MAX_REF),
  callerPurpose: z
    .string()
    .max(MAX_PURPOSE)
    .regex(/^[a-z][a-z0-9_]*$/),
  runId: uuidV7Schema.optional(),
  context: z
    .record(z.string().min(1).max(MAX_CONTEXT_KEY), z.string().max(MAX_CONTEXT_VALUE))
    .refine((c) => Object.keys(c).length <= MAX_CONTEXT_KEYS, 'too many context keys')
    .optional(),
});

export interface SecretResolveHandlerDeps {
  readonly resolver: SecretResolver;
  readonly tokens: ServiceTokenVerifier;
  /** CIDRs or single addresses of the services allowed to call. Empty refuses every request. */
  readonly allowedPeerCidrs: readonly string[];
  readonly metrics?: ResolveMetrics;
}

function peerList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix, ...rest] = entry.trim().split('/');
    const family = address === undefined ? 0 : isIP(address);
    const bits = prefix === undefined ? undefined : Number(prefix);
    const max = family === IPV4 ? IPV4_BITS : IPV6_BITS;
    if (
      address === undefined ||
      family === 0 ||
      rest.length > 0 ||
      (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || (bits ?? 0) > max))
    ) {
      throw new AppError('CONFIG_INVALID', 'invalid CIDR or address in the allowed peer list');
    }
    const type = family === IPV4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(address, type);
    else list.addSubnet(address, bits, type);
  }
  return list;
}

function send(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, code: ErrorCode, retryAfterSeconds?: number): void {
  const spec = ERROR_CODES[code];
  send(
    res,
    spec.status,
    { code, title: spec.title, status: spec.status, retryable: spec.retryable },
    retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) },
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
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

/** Normalises `::ffff:10.0.0.1` so one allowlist entry covers both spellings. */
function normalise(address: string): string {
  const bare = address.split('%', 1)[0] ?? address;
  return V4_MAPPED.exec(bare)?.[1] ?? bare;
}

/** Throws on a malformed allowlist, so the process refuses to start. */
export function createSecretResolveHandler(deps: SecretResolveHandlerDeps) {
  const { resolver, tokens, metrics } = deps;
  const peers = peerList(deps.allowedPeerCidrs);
  const configured = deps.allowedPeerCidrs.length > 0;

  function peerAllowed(remote: string | undefined): boolean {
    if (!configured || remote === undefined) return false;
    const address = normalise(remote);
    const family = isIP(address);
    return family !== 0 && peers.check(address, family === IPV4 ? 'ipv4' : 'ipv6');
  }

  function refuse(res: ServerResponse, service: string, code: ErrorCode): void {
    metrics?.resolved(service, 'denied');
    metrics?.denied(code);
    sendError(res, code);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.url ?? '').split('?')[0] !== SECRET_RESOLVE_PATH) {
      send(res, NOT_FOUND, { code: 'NOT_FOUND' });
      return;
    }
    if (!peerAllowed(req.socket.remoteAddress)) {
      metrics?.denied('peer_not_allowed');
      send(res, FORBIDDEN, { code: 'FORBIDDEN' });
      return;
    }
    if (req.method !== 'POST') {
      send(res, METHOD_NOT_ALLOWED, { code: 'METHOD_NOT_ALLOWED' }, { allow: 'POST' });
      return;
    }
    let caller;
    try {
      caller = await tokens.verify(req.headers.authorization);
    } catch {
      // Unauthenticated: no trustworthy tenant to attribute an audit event to, so it is counted, not audited.
      refuse(res, 'unknown', 'SERVICE_AUTH_FAILED');
      return;
    }
    const tenantId = req.headers[TENANT_HEADER];
    if (typeof tenantId !== 'string' || !TENANT.test(tenantId)) {
      refuse(res, caller.service, 'TENANT_CONTEXT_MISSING');
      return;
    }
    let request: z.infer<typeof resolveRequestSchema>;
    try {
      const parsed = resolveRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'invalid resolve request');
      request = parsed.data;
    } catch {
      refuse(res, caller.service, 'VALIDATION_FAILED');
      return;
    }
    const trace = req.headers[TRACE_HEADER];
    const { secretRef, callerPurpose, runId, context } = request;
    try {
      const secret = await resolver.resolve(
        {
          ...caller,
          tenantId,
          ...(typeof trace === 'string' && TRACE.test(trace) ? { traceId: trace } : {}),
        },
        {
          secretRef,
          callerPurpose,
          ...(runId === undefined ? {} : { runId }),
          ...(context === undefined ? {} : { context }),
        },
      );
      send(res, OK, secret);
    } catch (error) {
      // The resolver has already counted, logged and audited this failure.
      if (!isAppError(error)) {
        sendError(res, 'INTERNAL');
        return;
      }
      const retryAfter = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;
      sendError(res, error.code, typeof retryAfter === 'number' ? retryAfter : undefined);
    }
  };
}
