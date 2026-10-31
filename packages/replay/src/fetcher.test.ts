import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { httpFetcher, REPLAY_RESPONSE_BODY_MAX_BYTES } from './fetcher.js';

import type { AddressInfo } from 'node:net';

let server: Server;
let origin: string;

beforeEach(async () => {
  server = createServer((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { location: 'http://203.0.113.10/' });
      response.end();
      return;
    }
    if (request.url === '/large') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('a'.repeat(REPLAY_RESPONSE_BODY_MAX_BYTES + 4096));
      return;
    }
    if (request.url === '/cookies') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': ['sid=1; HttpOnly', 'pref=2; Path=/'],
      });
      response.end('ok');
      return;
    }
    response.writeHead(500, { 'content-type': 'text/html' });
    response.end('<title>SQLITE_ERROR: near</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

describe('httpFetcher', () => {
  it('returns the status and the decoded body of a GET', async () => {
    const result = await httpFetcher(`${origin}/search`);
    expect(result).toMatchObject({ status: 500, body: '<title>SQLITE_ERROR: near</title>' });
  });

  it('returns lowercased headers and one entry per Set-Cookie value', async () => {
    const result = await httpFetcher(`${origin}/cookies`);
    expect(result.headers).toEqual(
      expect.arrayContaining([
        { name: 'content-type', value: 'text/html' },
        { name: 'set-cookie', value: 'sid=1; HttpOnly' },
        { name: 'set-cookie', value: 'pref=2; Path=/' },
      ]),
    );
    expect(result.headers?.filter((header) => header.name === 'set-cookie')).toHaveLength(2);
  });

  it('cuts an oversized body at the byte bound instead of loading it whole', async () => {
    const result = await httpFetcher(`${origin}/large`);
    expect(result.body).toHaveLength(REPLAY_RESPONSE_BODY_MAX_BYTES);
    expect(result.status).toBe(200);
  });

  it('refuses to follow a redirect out of the verified scope (fails closed)', async () => {
    await expect(httpFetcher(`${origin}/redirect`)).rejects.toThrow();
  });
});
