import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { HTTP_CHALLENGE_PATH, type VerificationProbeTarget } from '@blackwing/domain';

import { HttpFileProbe, normaliseTokenBody } from './http-file-probe.js';

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The HTTP-file probe (ASSET-006) against a real HTTPS stub on loopback. The stub's certificate is self-signed for
 * `verify.test` (and the punycode form of `bücher.test`); the probe trusts it through the test-only `trustedCa`
 * option, and resolves `verify.test` to loopback through the injected resolver, so no DNS is involved.
 */

const TOKEN = 'blackwing-site-verification=MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43UOV3HO6DZPI';
const HOST = 'verify.test';
const LOCATION = `https://${HOST}${HTTP_CHALLENGE_PATH}`;

let workDir: string;
let certPem: string;
let keyPem: string;

/** What the stub answers for the challenge path. Reset before every test. */
type Responder = (req: IncomingMessage, res: ServerResponse) => void;
let respond: Responder = () => undefined;
let hits: string[] = [];

let server: Server;
let port: number;

function target(overrides: Partial<VerificationProbeTarget> = {}): VerificationProbeTarget {
  return {
    method: 'http_file',
    token: TOKEN,
    expectedLocation: LOCATION,
    identifiers: [{ kind: 'host', value: HOST }],
    ...overrides,
  };
}

function trustedProbe(extra: ConstructorParameters<typeof HttpFileProbe>[0] = {}): HttpFileProbe {
  return new HttpFileProbe({
    port,
    trustedCa: certPem,
    resolve: () => Promise.resolve({ address: '127.0.0.1', family: 4 }),
    timeoutMs: 1000,
    ...extra,
  });
}

/** Answers the challenge path with `body` and the given status and content type. */
function serve(body: string | Buffer, status = 200, contentType = 'text/plain; charset=utf-8') {
  respond = (_req, res) => {
    res.writeHead(status, { 'content-type': contentType });
    res.end(body);
  };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'bw-http-file-probe-'));
  const make = (name: string, sans: string) => {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(workDir, `${name}.key`),
        '-out',
        join(workDir, `${name}.crt`),
        '-days',
        '2',
        '-subj',
        `/CN=${sans.split(',')[0]?.replace('DNS:', '') ?? name}`,
        '-addext',
        `subjectAltName=${sans}`,
      ],
      { stdio: 'ignore' },
    );
    return {
      cert: readFileSync(join(workDir, `${name}.crt`), 'utf8'),
      key: readFileSync(join(workDir, `${name}.key`), 'utf8'),
    };
  };
  const served = make('served', `DNS:${HOST},DNS:xn--bcher-kva.test`);
  certPem = served.cert;
  keyPem = served.key;
  server = createHttpsServer({ key: keyPem, cert: certPem }, (req, res) => {
    hits.push(req.url ?? '');
    respond(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server has no port');
  port = address.port;
});

afterEach(() => {
  server.closeAllConnections();
  hits = [];
  respond = () => undefined;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  rmSync(workDir, { recursive: true, force: true });
});

describe('normaliseTokenBody', () => {
  it('strips a UTF-8 byte order mark and surrounding whitespace, and nothing else', () => {
    expect(normaliseTokenBody(`\uFEFF  ${TOKEN}\r\n`)).toBe(TOKEN);
    expect(normaliseTokenBody(`${TOKEN}\nextra`)).toBe(`${TOKEN}\nextra`);
    expect(normaliseTokenBody(`x${TOKEN}`)).toBe(`x${TOKEN}`);
  });
});

describe('HttpFileProbe: the served file', () => {
  it('passes when the trimmed body is exactly the token, over valid TLS', async () => {
    serve(`${TOKEN}\n`);
    const record = vi.fn();
    const result = await trustedProbe({ record }).check(target());
    expect(result).toEqual({ outcome: 'passed' });
    expect(record).toHaveBeenCalledWith('passed', 'token_found');
    expect(hits).toEqual([HTTP_CHALLENGE_PATH]);
  });

  it('normalises a byte order mark and CRLF line endings before comparing', async () => {
    serve(`\uFEFF${TOKEN}\r\n`);
    expect(await trustedProbe().check(target())).toEqual({ outcome: 'passed' });
  });

  it('refuses a different token, or the token with extra text (strict match)', async () => {
    const record = vi.fn();
    serve(`blackwing-site-verification=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
    expect(await trustedProbe({ record }).check(target())).toEqual({
      outcome: 'not_found',
      reason: 'token_absent',
    });
    serve(`${TOKEN}\nanother line`);
    expect(await trustedProbe({ record }).check(target())).toEqual({
      outcome: 'not_found',
      reason: 'token_absent',
    });
    expect(record).toHaveBeenCalledWith('not_found', 'token_absent');
  });

  it('is a miss, not a pass, for a 404 with the right token in the body', async () => {
    serve(TOKEN, 404);
    expect(await trustedProbe().check(target())).toEqual({
      outcome: 'not_found',
      reason: 'unexpected_status',
    });
  });

  it('is a miss for a non-text content type, even with the right token', async () => {
    serve(TOKEN, 200, 'application/json');
    expect(await trustedProbe().check(target())).toEqual({
      outcome: 'not_found',
      reason: 'unexpected_content_type',
    });
  });

  it('treats an oversized body as no match, cut at the byte cap before trimming', async () => {
    // The token is followed by whitespace that the trim would remove; the cap cuts first, so it is still a miss.
    serve(`${TOKEN}${' '.repeat(5000)}`);
    const record = vi.fn();
    expect(await trustedProbe({ record, maxBytes: 4096 }).check(target())).toEqual({
      outcome: 'not_found',
      reason: 'body_too_large',
    });
    expect(record).toHaveBeenCalledWith('not_found', 'body_too_large');
  });

  it('passes a body that is exactly at the byte cap', async () => {
    serve(`${TOKEN}${' '.repeat(4096 - TOKEN.length)}`);
    expect(await trustedProbe({ maxBytes: 4096 }).check(target())).toEqual({ outcome: 'passed' });
  });
});

describe('HttpFileProbe: redirects and transport', () => {
  it('never follows a redirect: a 301 to a path that serves the token is a miss', async () => {
    respond = (req, res) => {
      if (req.url === HTTP_CHALLENGE_PATH) {
        res.writeHead(301, { location: 'https://verify.test/elsewhere.txt' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(TOKEN);
    };
    expect(await trustedProbe().check(target())).toEqual({
      outcome: 'not_found',
      reason: 'redirect_not_allowed',
    });
    expect(hits).toEqual([HTTP_CHALLENGE_PATH]);
  });

  it('throws on a 5xx answer, so the framework counts a retryable probe_error', async () => {
    serve('busy', 503);
    const record = vi.fn();
    await expect(trustedProbe({ record }).check(target())).rejects.toThrow('server_error');
    expect(record).toHaveBeenCalledWith('probe_error', 'server_error');
  });

  it('throws on a timeout, so a slow origin is retryable and never a pass', async () => {
    respond = () => undefined; // never answers
    const record = vi.fn();
    await expect(trustedProbe({ record, timeoutMs: 200 }).check(target())).rejects.toThrow(
      'timeout',
    );
    expect(record).toHaveBeenCalledWith('probe_error', 'timeout');
  });

  it('fails a self-signed certificate that the trust store does not hold: tls_error', async () => {
    serve(TOKEN);
    const record = vi.fn();
    const probe = new HttpFileProbe({
      port,
      resolve: () => Promise.resolve({ address: '127.0.0.1', family: 4 }),
      timeoutMs: 1000,
      record,
    });
    expect(await probe.check(target())).toEqual({ outcome: 'not_found', reason: 'tls_error' });
    expect(record).toHaveBeenCalledWith('not_found', 'tls_error');
  });

  it('fails a certificate that does not name the asset host: tls_error', async () => {
    serve(TOKEN);
    const result = await trustedProbe().check(
      target({ expectedLocation: `https://other.test${HTTP_CHALLENGE_PATH}` }),
    );
    expect(result).toEqual({ outcome: 'not_found', reason: 'tls_error' });
  });

  it('accepts the punycode (A-label) form of an IDN host', async () => {
    serve(TOKEN);
    const resolve = vi.fn(() => Promise.resolve({ address: '127.0.0.1', family: 4 }));
    const result = await trustedProbe({ resolve }).check(
      target({ expectedLocation: `https://b\u00FCcher.test${HTTP_CHALLENGE_PATH}` }),
    );
    expect(result).toEqual({ outcome: 'passed' });
    expect(resolve).toHaveBeenCalledWith('xn--bcher-kva.test');
  });

  it('resolves the host exactly once per run and connects to that answer', async () => {
    serve(TOKEN);
    const resolve = vi.fn(() => Promise.resolve({ address: '127.0.0.1', family: 4 }));
    await trustedProbe({ resolve }).check(target());
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('throws when the host does not resolve, without opening a connection', async () => {
    serve(TOKEN);
    const record = vi.fn();
    const probe = trustedProbe({
      record,
      resolve: () => Promise.reject(new Error('ENOTFOUND')),
    });
    await expect(probe.check(target())).rejects.toThrow('resolve_error');
    expect(record).toHaveBeenCalledWith('probe_error', 'resolve_error');
    expect(hits).toEqual([]);
  });
});

describe('HttpFileProbe: the challenge location is refused unless it is exact', () => {
  it.each([
    ['plain http', `http://${HOST}${HTTP_CHALLENGE_PATH}`],
    ['another path', `https://${HOST}/other.txt`],
    ['embedded credentials', `https://user:pw@${HOST}${HTTP_CHALLENGE_PATH}`],
    ['a query string', `https://${HOST}${HTTP_CHALLENGE_PATH}?x=1`],
    ['no location', ''],
  ])('refuses %s with invalid_location and makes no request', async (_name, location) => {
    serve(TOKEN);
    const resolve = vi.fn(() => Promise.resolve({ address: '127.0.0.1', family: 4 }));
    const result = await trustedProbe({ resolve }).check(
      target({ expectedLocation: location === '' ? null : location }),
    );
    expect(result).toEqual({ outcome: 'not_found', reason: 'invalid_location' });
    expect(resolve).not.toHaveBeenCalled();
    expect(hits).toEqual([]);
  });
});
