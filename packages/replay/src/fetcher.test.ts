import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { httpFetcher } from './fetcher.js';

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
    await expect(httpFetcher(`${origin}/search`)).resolves.toEqual({
      status: 500,
      body: '<title>SQLITE_ERROR: near</title>',
    });
  });

  it('refuses to follow a redirect out of the verified scope (fails closed)', async () => {
    await expect(httpFetcher(`${origin}/redirect`)).rejects.toThrow();
  });
});
