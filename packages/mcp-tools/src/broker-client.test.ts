import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createBrokerClient } from './broker-client.js';
import { ToolError } from './errors.js';

import type { AddressInfo } from 'node:net';

const RUN = '01890a5d-ac96-774b-bcce-b302099a8057';
const TOKEN = 'bwrun_secret-token-value.signature';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: string;
}

let server: Server;
let baseUrl: string;
let seen: Seen[];
let respond: (res: ServerResponse) => void;

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
}

beforeEach(async () => {
  seen = [];
  respond = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"value":1}');
  };
  server = createHttpServer((req, res) => {
    void readBody(req).then((body) => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const client = (extra: Partial<Parameters<typeof createBrokerClient>[0]> = {}) =>
  createBrokerClient({ baseUrl, runId: RUN, token: TOKEN, ...extra });

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ToolError);
  const { code, message } = error as ToolError;
  return { code, message };
}

describe('createBrokerClient', () => {
  it('sends the run-scoped bearer token to the run path and parses the response', async () => {
    const result = await client().get('state', z.object({ value: z.number() }));
    expect(result).toEqual({ value: 1 });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: `/internal/broker/runs/${RUN}/state`,
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('posts a JSON body and resolves undefined for an empty response', async () => {
    respond = (res) => res.writeHead(204).end();
    await expect(client().post('tool-audit', { a: 1 })).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({ method: 'POST', body: '{"a":1}' });
  });

  it('maps an unreachable broker to TOOL_BACKEND_UNAVAILABLE without leaking the token', async () => {
    await new Promise((resolve) => server.close(resolve));
    const failure = await codeOf(client().get('state', z.unknown()));
    expect(failure.code).toBe('TOOL_BACKEND_UNAVAILABLE');
    expect(failure.message).not.toContain(TOKEN);
  });

  it('maps a timeout to TOOL_BACKEND_UNAVAILABLE', async () => {
    respond = () => undefined;
    const failure = await codeOf(client({ timeoutMs: 50 }).get('state', z.unknown()));
    expect(failure.code).toBe('TOOL_BACKEND_UNAVAILABLE');
  });

  it.each([401, 403])('maps %i to TOOL_SCOPE_DENIED', async (status) => {
    respond = (res) => res.writeHead(status).end();
    expect((await codeOf(client().post('journal', {}))).code).toBe('TOOL_SCOPE_DENIED');
  });

  it('maps RUN_NOT_ACTIVE to TOOL_KILLED', async () => {
    respond = (res) => {
      res
        .writeHead(409, { 'content-type': 'application/problem+json' })
        .end('{"code":"RUN_NOT_ACTIVE"}');
    };
    expect((await codeOf(client().post('journal', {}))).code).toBe('TOOL_KILLED');
  });

  it.each([500, 501, 429, 422])(
    'maps %i to TOOL_BACKEND_UNAVAILABLE (fail closed)',
    async (status) => {
      respond = (res) => res.writeHead(status).end('{"detail":"internal secret detail"}');
      const failure = await codeOf(client().post('journal', {}));
      expect(failure.code).toBe('TOOL_BACKEND_UNAVAILABLE');
      expect(failure.message).not.toContain('internal secret detail');
    },
  );

  it('rejects an invalid or schema-violating response body', async () => {
    respond = (res) => res.writeHead(200).end('not json');
    expect((await codeOf(client().get('state', z.unknown()))).code).toBe(
      'TOOL_BACKEND_UNAVAILABLE',
    );
    respond = (res) => res.writeHead(200).end('{"value":"x"}');
    const schema = z.object({ value: z.number() });
    expect((await codeOf(client().get('state', schema))).code).toBe('TOOL_BACKEND_UNAVAILABLE');
  });

  it('does not follow redirects, so the token never reaches another origin', async () => {
    respond = (res) => res.writeHead(302, { location: 'http://127.0.0.1:1/steal' }).end();
    expect((await codeOf(client().get('state', z.unknown()))).code).toBe(
      'TOOL_BACKEND_UNAVAILABLE',
    );
    expect(seen).toHaveLength(1);
  });

  it('fails with TOOL_KILLED before sending when the session is already killed', async () => {
    const killed = AbortSignal.abort();
    expect((await codeOf(client({ signal: killed }).get('state', z.unknown()))).code).toBe(
      'TOOL_KILLED',
    );
    expect(seen).toHaveLength(0);
  });

  it('fails with TOOL_KILLED when the session is killed mid-request', async () => {
    respond = () => undefined;
    const controller = new AbortController();
    const pending = codeOf(client({ signal: controller.signal }).get('state', z.unknown()));
    setTimeout(() => {
      controller.abort();
    }, 30);
    expect((await pending).code).toBe('TOOL_KILLED');
  });

  it('refuses unsafe construction and unsafe paths', async () => {
    expect(() => client({ baseUrl: 'ftp://broker' })).toThrow(TypeError);
    expect(() => client({ baseUrl: 'http://user:pw@broker' })).toThrow(TypeError);
    expect(() => client({ runId: '../x' })).toThrow(TypeError);
    expect(() => client({ token: '' })).toThrow(TypeError);
    await expect(client().get('../state', z.unknown())).rejects.toBeInstanceOf(TypeError);
  });
});
