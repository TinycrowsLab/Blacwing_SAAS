// Blackwing synthetic lab: a BOLA/BFLA JSON API (EVAL-001, #796). Stdlib only, deterministic data, so the
// ground truth (EVAL-002) is stable across runs. Tokens are fixed lab credentials, referenced from target.json.
//
// Deliberate flaws (ground truth): GET /api/v1/invoices/:id has no owner check (BOLA); GET /api/v1/admin/users
// has no role check (BFLA). Controls that DO enforce ownership or role are /api/v1/users/:id/profile and the
// 401 path, so a scorer can tell a real finding from a correct response.

import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {{ id: number, name: string, role: 'user' | 'admin', token: string }} LabUser */
/** @typedef {{ id: number, ownerId: number, amountCents: number, memo: string }} LabInvoice */
/** @typedef {{ status: number, body: unknown }} LabResponse */

const HTTP = Object.freeze({
  ok: 200,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
});

/** @type {readonly LabUser[]} */
export const LAB_USERS = Object.freeze([
  { id: 1, name: 'alice', role: 'user', token: 'lab-token-alice' },
  { id: 2, name: 'bob', role: 'user', token: 'lab-token-bob' },
  { id: 3, name: 'admin', role: 'admin', token: 'lab-token-admin' },
]);

/** @type {readonly LabInvoice[]} */
export const LAB_INVOICES = Object.freeze([
  { id: 101, ownerId: 1, amountCents: 12000, memo: 'alice: hosting' },
  { id: 102, ownerId: 2, amountCents: 98050, memo: 'bob: consulting' },
  { id: 103, ownerId: 1, amountCents: 4500, memo: 'alice: domain' },
]);

/**
 * The user behind a bearer token, or undefined (fail closed: unknown or malformed tokens authenticate nobody).
 * @param {string | undefined} header
 * @returns {LabUser | undefined}
 */
export function authenticate(header) {
  const match = /^Bearer ([A-Za-z0-9-]{1,64})$/.exec(header ?? '');
  if (match === null) return undefined;
  const token = match[1];
  return LAB_USERS.find((user) => user.token === token);
}

/**
 * Routes one request. Pure: no IO, so every route is testable without a socket.
 * @param {{ method: string, path: string, authorization: string | undefined }} request
 * @returns {LabResponse}
 */
export function handle(request) {
  if (request.method === 'GET' && request.path === '/healthz')
    return { status: HTTP.ok, body: { status: 'ok' } };
  if (request.method !== 'GET')
    return { status: HTTP.methodNotAllowed, body: { code: 'METHOD_NOT_ALLOWED' } };

  const caller = authenticate(request.authorization);
  if (caller === undefined) return { status: HTTP.unauthorized, body: { code: 'UNAUTHENTICATED' } };

  const invoice = /^\/api\/v1\/invoices\/(\d+)$/.exec(request.path);
  if (invoice !== null) {
    // BOLA: returns any invoice to any authenticated caller. The ownership check is missing on purpose.
    const found = LAB_INVOICES.find((row) => row.id === Number(invoice[1]));
    return found === undefined
      ? { status: HTTP.notFound, body: { code: 'NOT_FOUND' } }
      : { status: HTTP.ok, body: found };
  }

  const profile = /^\/api\/v1\/users\/(\d+)\/profile$/.exec(request.path);
  if (profile !== null) {
    // Control: enforces ownership (or admin), so cross-user reads must return 403.
    const id = Number(profile[1]);
    if (caller.id !== id && caller.role !== 'admin')
      return { status: HTTP.forbidden, body: { code: 'FORBIDDEN' } };
    const user = LAB_USERS.find((row) => row.id === id);
    return user === undefined
      ? { status: HTTP.notFound, body: { code: 'NOT_FOUND' } }
      : { status: HTTP.ok, body: { id: user.id, name: user.name, role: user.role } };
  }

  if (request.path === '/api/v1/admin/users') {
    // BFLA: the admin listing has no role check, so any authenticated caller reads it.
    return {
      status: HTTP.ok,
      body: LAB_USERS.map((user) => ({ id: user.id, name: user.name, role: user.role })),
    };
  }

  return { status: HTTP.notFound, body: { code: 'NOT_FOUND' } };
}

/**
 * Builds the lab HTTP server. Exported so the tests run it on an ephemeral port.
 * @returns {import('node:http').Server}
 */
export function createBolaApi() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://lab.local');
    const reply = handle({
      method: req.method ?? '',
      path: url.pathname,
      authorization: req.headers.authorization,
    });
    res.writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(reply.body));
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? '8080');
  createBolaApi().listen(port, '0.0.0.0', () => {
    process.stdout.write(`bola-api listening on ${String(port)}\n`);
  });
}
