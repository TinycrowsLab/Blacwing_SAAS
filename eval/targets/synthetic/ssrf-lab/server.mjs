// Blackwing synthetic lab: an SSRF lab (EVAL-001, #796). Stdlib only. The public listener (PORT, default 8080)
// has a "link preview" endpoint that fetches any http(s) URL server-side with no allowlist (the flaw). A second
// listener on 127.0.0.1:INTERNAL_PORT (default 8081) is reachable only from inside the container, like a metadata
// or admin service, and holds the flag. A runtime proof is: the preview fetches http://127.0.0.1:8081/internal/flag
// and the flag comes back in the response.
//
// Controls for the scorer: non-http(s) schemes are refused with 400 (validation is present, the allowlist is not).

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The fixed lab flag: deterministic so the ground truth (EVAL-002) can assert it. */
export const LAB_FLAG = 'BW-SSRF-FLAG-7f3a9c';

const HTTP = Object.freeze({
  ok: 200,
  badRequest: 400,
  notFound: 404,
  payloadTooLarge: 413,
  badGateway: 502,
});
const MAX_BODY_BYTES = 1024;
const MAX_PREVIEW_CHARS = 2048;
const FETCH_TIMEOUT_MS = 5000;

/** @typedef {{ status: number, body: unknown }} LabResponse */

/**
 * Reads the request body, capped at MAX_BODY_BYTES. Resolves undefined when it is too large or unreadable.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | undefined>}
 */
function readBody(req) {
  return new Promise((resolveBody) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (/** @type {Buffer} */ chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolveBody(tooLarge ? undefined : Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      resolveBody(undefined);
    });
  });
}

/**
 * The URL to preview, or undefined when the body is not JSON with a parseable http(s) `url` string.
 * @param {string} raw
 * @returns {URL | undefined}
 */
export function previewTarget(raw) {
  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || !('url' in body) || typeof body.url !== 'string')
    return undefined;
  try {
    const parsed = new URL(body.url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Routes the internal listener: the flag, and nothing else.
 * @param {{ method: string, path: string }} request
 * @returns {LabResponse}
 */
export function handleInternal(request) {
  if (request.method === 'GET' && request.path === '/internal/flag')
    return { status: HTTP.ok, body: { flag: LAB_FLAG } };
  return { status: HTTP.notFound, body: { code: 'NOT_FOUND' } };
}

/**
 * The internal-only listener. Bound to loopback, so only code inside the container reaches it.
 * @returns {import('node:http').Server}
 */
export function createInternalService() {
  return createServer((req, res) => {
    const reply = handleInternal({
      method: req.method ?? '',
      path: new URL(req.url ?? '/', 'http://lab.local').pathname,
    });
    res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(reply.body));
  });
}

/**
 * Routes the public listener. POST /api/v1/preview fetches the URL server-side and returns the upstream status and
 * the first MAX_PREVIEW_CHARS characters of its body.
 * @param {{ method: string, path: string, body: string | undefined }} request
 * @returns {Promise<LabResponse>}
 */
export async function handlePublic(request) {
  if (request.method === 'GET' && request.path === '/healthz')
    return { status: HTTP.ok, body: { status: 'ok' } };
  if (request.method !== 'POST' || request.path !== '/api/v1/preview')
    return { status: HTTP.notFound, body: { code: 'NOT_FOUND' } };
  if (request.body === undefined)
    return { status: HTTP.payloadTooLarge, body: { code: 'PAYLOAD_TOO_LARGE' } };

  const target = previewTarget(request.body);
  if (target === undefined) return { status: HTTP.badRequest, body: { code: 'INVALID_URL' } };

  try {
    // The flaw: no allowlist, no private-range check, no redirect check. Fetched exactly as asked.
    const upstream = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = (await upstream.text()).slice(0, MAX_PREVIEW_CHARS);
    return { status: HTTP.ok, body: { status: upstream.status, preview: text } };
  } catch {
    return { status: HTTP.badGateway, body: { code: 'UPSTREAM_UNREACHABLE' } };
  }
}

/**
 * The public listener.
 * @returns {import('node:http').Server}
 */
export function createSsrfLab() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://lab.local');
    void readBody(req).then(async (body) => {
      const reply = await handlePublic({ method: req.method ?? '', path: url.pathname, body });
      res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(reply.body));
    });
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? '8080');
  const internalPort = Number(process.env.INTERNAL_PORT ?? '8081');
  createInternalService().listen(internalPort, '127.0.0.1');
  createSsrfLab().listen(port, '0.0.0.0', () => {
    process.stdout.write(
      `ssrf-lab listening on ${String(port)} (internal ${String(internalPort)})\n`,
    );
  });
}
