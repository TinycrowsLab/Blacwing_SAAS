import {
  constants as cryptoConstants,
  createCipheriv,
  createPublicKey,
  generateKeyPairSync,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AppError, ValidationError } from '@blackwing/errors';

import { OobClient, type OobClientOptions } from './client.js';
import {
  AES_IV_BYTES,
  AES_KEY_BYTES,
  INTERACTSH_PROTOCOL_VERSION,
  MAX_RECORDS_PER_POLL,
  MAX_RESPONSE_BYTES,
} from './protocol.js';

const SERVER = 'https://oob.example.test';
const TOKEN = 'listener-token-for-tests';
const DOMAIN = 'oob.example.test';
const RECEIVED = new Date('2026-10-31T12:00:00.000Z');

type Fetch = NonNullable<OobClientOptions['fetch']>;

interface Session {
  readonly id: string;
  readonly secret: string;
  readonly publicKeyPem: string;
  readonly pending: string[];
}

/**
 * An in-process interactsh-server double. It implements the register/poll/deregister wire protocol the
 * way the real server does (per-poll AES-256 key wrapped with RSA-OAEP-SHA256, CFB records with a leading
 * IV), so the client is exercised against the real encoding without a network. Failure switches let tests
 * drive every typed error path.
 */
class FakeListener {
  readonly sessions = new Map<string, Session>();
  readonly calls: {
    method: string;
    path: string;
    authorization: string | null;
    redirect: string | undefined;
  }[] = [];
  version: string | null = INTERACTSH_PROTOCOL_VERSION;
  token = TOKEN;
  unreachable = false;
  /** Replaces the body of the next poll response (for malformed-body tests). */
  nextPollBody: string | undefined;
  /** When set, poll wraps the AES key to this key instead of the session key (decrypt-failure tests). */
  wrapToOtherKey = false;

  route(input: Parameters<Fetch>[0], init: Parameters<Fetch>[1]): Response {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    this.calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      authorization: headers.get('authorization'),
      redirect: init?.redirect,
    });
    if (this.unreachable) throw new TypeError('fetch failed');
    const versioned = (body: string, status = 200, extra: Record<string, string> = {}): Response =>
      new Response(body, {
        status,
        headers: {
          'content-type': 'application/json',
          ...(this.version === null ? {} : { 'x-interactsh-version': this.version }),
          ...extra,
        },
      });

    if (url.pathname === '/' && init?.method !== 'POST') {
      return new Response('<h1> Interactsh Server </h1>', {
        status: 200,
        headers: this.version === null ? {} : { 'x-interactsh-version': this.version },
      });
    }
    if (headers.get('authorization') !== this.token) {
      return versioned('{"error":"unauthorized"}', 401);
    }
    if (url.pathname === '/register' && init?.method === 'POST') {
      const body = JSON.parse(bodyText(init)) as Record<string, string>;
      const pem = Buffer.from(body['public-key'] ?? '', 'base64').toString('utf8');
      this.sessions.set(body['correlation-id'] ?? '', {
        id: body['correlation-id'] ?? '',
        secret: body['secret-key'] ?? '',
        publicKeyPem: pem,
        pending: [],
      });
      return versioned('{"message":"registration successful"}');
    }
    if (url.pathname === '/poll') {
      const session = this.sessions.get(url.searchParams.get('id') ?? '');
      if (session?.secret === undefined || session.secret !== url.searchParams.get('secret')) {
        return versioned('{"error":"invalid secret key"}', 400);
      }
      if (this.nextPollBody !== undefined) {
        const body = this.nextPollBody;
        this.nextPollBody = undefined;
        return versioned(body);
      }
      const aesKey = randomBytes(AES_KEY_BYTES);
      const wrapTo = createPublicKey(this.wrapToOtherKey ? OTHER_PEM : session.publicKeyPem);
      const wrapped = publicEncrypt(
        { key: wrapTo, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        aesKey,
      ).toString('base64');
      const data = session.pending.splice(0).map((plain) => {
        const iv = randomBytes(AES_IV_BYTES);
        const cipher = createCipheriv('aes-256-cfb', aesKey, iv);
        return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
      });
      return versioned(
        JSON.stringify({ data: data.length === 0 ? null : data, extra: null, aes_key: wrapped }),
      );
    }
    if (url.pathname === '/deregister' && init?.method === 'POST') {
      const body = JSON.parse(bodyText(init)) as Record<string, string>;
      const session = this.sessions.get(body['correlation-id'] ?? '');
      if (session === undefined || session.secret !== body['secret-key']) {
        return versioned('{"error":"invalid"}', 400);
      }
      this.sessions.delete(session.id);
      return versioned('{"message":"deregistration successful"}');
    }
    return versioned('{"error":"not found"}', 404);
  }

  readonly fetch: Fetch = (input, init) => {
    try {
      return Promise.resolve(this.route(input, init));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };

  /** Queues one interaction record (plaintext JSON) for the session's next poll. */
  deliver(correlationId: string, record: Record<string, unknown> | string): void {
    const session = this.sessions.get(correlationId);
    if (session === undefined) throw new Error('no such session');
    session.pending.push(typeof record === 'string' ? record : JSON.stringify(record));
  }
}

/** An unrelated RSA public key, generated once: wrapping to it is what a key mismatch looks like. */
const OTHER_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

/** The request body as text (the client always sends a JSON string). */
function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

function makeClient(listener: FakeListener, overrides: Partial<OobClientOptions> = {}): OobClient {
  return new OobClient({
    serverUrl: SERVER,
    token: TOKEN,
    domain: DOMAIN,
    fetch: listener.fetch,
    now: () => RECEIVED,
    ...overrides,
  });
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

function dnsRecord(correlationId: string, nonce = 'nonce1234567'): Record<string, unknown> {
  return {
    protocol: 'dns',
    'unique-id': `${correlationId}${nonce}`,
    'full-id': `${correlationId}${nonce}`,
    'remote-address': '198.51.100.9:53',
    timestamp: '2026-10-31T11:59:58.000000001Z',
    'raw-request': 'query A',
  };
}

describe('OobClient construction', () => {
  it('mints the per-test host as correlation id + nonce under the domain', () => {
    const client = makeClient(new FakeListener());
    expect(client.correlationId).toMatch(/^[a-z2-7]{20}$/);
    expect(client.hostFor('abcdefg234567')).toBe(`${client.correlationId}abcdefg234567.${DOMAIN}`);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'abcdefghijklmn'],
    ['uppercase', 'ABCDEFGHIJKLM'],
    ['a dot', 'abcdef.ghijk'],
    ['empty', ''],
  ])('refuses a %s nonce (the listener would not correlate it)', (_label, nonce) => {
    const client = makeClient(new FakeListener());
    expect(() => client.hostFor(nonce)).toThrow(ValidationError);
  });

  it('gives every client its own correlation id', () => {
    const a = makeClient(new FakeListener());
    const b = makeClient(new FakeListener());
    expect(a.correlationId).not.toBe(b.correlationId);
  });

  it.each([
    ['a non-URL server', { serverUrl: 'not a url' }],
    ['a non-http scheme', { serverUrl: 'ftp://oob.example.test' }],
    ['an empty token', { token: '' }],
    ['a domain with a path', { domain: 'oob.example.test/x' }],
    ['an empty domain', { domain: '' }],
  ])('rejects %s with a validation error and never reaches the network', (_label, override) => {
    const listener = new FakeListener();
    expect(() => makeClient(listener, override as Partial<OobClientOptions>)).toThrow(
      ValidationError,
    );
    expect(listener.calls).toHaveLength(0);
  });
});

describe('OobClient register', () => {
  it('checks the pinned version, then registers the public key, correlation id and secret with the token', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    const registerCall = listener.calls.find((call) => call.path === '/register');
    expect(registerCall).toMatchObject({ method: 'POST', authorization: TOKEN, redirect: 'error' });
    expect(listener.calls[0]).toMatchObject({ method: 'GET', path: '/' });
    expect(listener.sessions.get(client.correlationId)?.publicKeyPem).toMatch(/BEGIN PUBLIC KEY/);
  });

  it('fails closed when the listener advertises a different protocol version', async () => {
    const listener = new FakeListener();
    listener.version = '1.3.0';
    const error = await errorOf(makeClient(listener).register());
    expect(error.code).toBe('OOB_PROTOCOL_INCOMPATIBLE');
    expect(listener.calls.some((call) => call.path === '/register')).toBe(false);
  });

  it('fails closed when the listener advertises no version at all', async () => {
    const listener = new FakeListener();
    listener.version = null;
    const error = await errorOf(makeClient(listener).register());
    expect(error.code).toBe('OOB_PROTOCOL_INCOMPATIBLE');
  });

  it('reports an unreachable listener as OOB_REGISTER_FAILED (retryable) and keeps the cause out of the message', async () => {
    const listener = new FakeListener();
    listener.unreachable = true;
    const error = await errorOf(makeClient(listener).register());
    expect(error.code).toBe('OOB_REGISTER_FAILED');
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it('reports a rejected token as OOB_REGISTER_FAILED without echoing the token', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener, { token: 'wrong-token' });
    const error = await errorOf(client.register());
    expect(error.code).toBe('OOB_REGISTER_FAILED');
    expect(error.detail).toContain('401');
    expect(JSON.stringify(error)).not.toContain('wrong-token');
  });

  it('refuses a second registration on the same session', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    const error = await errorOf(client.register());
    expect(error.code).toBe('OOB_REGISTER_FAILED');
  });

  it('allows a retry after a failed registration', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    listener.unreachable = true;
    await expect(client.register()).rejects.toThrow(AppError);
    listener.unreachable = false;
    await client.register();
    expect(await client.poll()).toEqual([]);
  });
});

describe('OobClient poll', () => {
  it('returns decrypted interactions correlated to this session, with server and local time kept apart', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.deliver(client.correlationId, dnsRecord(client.correlationId));
    const [interaction] = await client.poll();
    expect(interaction).toEqual({
      protocol: 'dns',
      correlationId: client.correlationId,
      fullId: `${client.correlationId}nonce1234567`,
      remoteAddress: '198.51.100.9:53',
      timestamp: new Date('2026-10-31T11:59:58.000Z'),
      receivedAt: RECEIVED,
      rawRequest: Buffer.from('query A', 'utf8').toString('base64'),
    });
  });

  it('serves each interaction at most once', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.deliver(client.correlationId, dnsRecord(client.correlationId));
    expect(await client.poll()).toHaveLength(1);
    expect(await client.poll()).toEqual([]);
  });

  it('returns an empty batch for an empty poll (the listener omits data entirely)', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    expect(await client.poll()).toEqual([]);
  });

  it('decrypts a batch of several interactions in the order the listener served them', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    for (let i = 0; i < 5; i += 1) {
      listener.deliver(
        client.correlationId,
        dnsRecord(client.correlationId, `nonce${i}`.padEnd(13, 'x')),
      );
    }
    const batch = await client.poll();
    expect(batch.map((interaction) => interaction.fullId)).toEqual(
      Array.from({ length: 5 }, (_, i) => `${client.correlationId}${`nonce${i}`.padEnd(13, 'x')}`),
    );
  });

  it('sends the session secret and the token on the poll, never following redirects', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    await client.poll();
    expect(listener.calls.at(-1)).toMatchObject({
      path: '/poll',
      authorization: TOKEN,
      redirect: 'error',
    });
  });

  it('refuses to poll before registration', async () => {
    const listener = new FakeListener();
    const error = await errorOf(makeClient(listener).poll());
    expect(error.code).toBe('OOB_POLL_FAILED');
    expect(listener.calls).toHaveLength(0);
  });

  it('reports an unreachable listener as OOB_POLL_FAILED (retryable), never as an empty batch', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.unreachable = true;
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_POLL_FAILED');
    expect(error.retryable).toBe(true);
  });

  it('reports an HTTP refusal from the listener as OOB_POLL_FAILED', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.sessions.clear();
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_POLL_FAILED');
    expect(error.detail).toContain('400');
  });

  it('fails with OOB_DECRYPT_FAILED when the batch key was wrapped to another key (a key mismatch is never a silent miss)', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.wrapToOtherKey = true;
    listener.deliver(client.correlationId, dnsRecord(client.correlationId));
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_DECRYPT_FAILED');
    expect(error.retryable).toBe(false);
  });

  it('fails with OOB_DECRYPT_FAILED when a record decrypts to something that is not JSON', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.deliver(client.correlationId, 'this is not json');
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_DECRYPT_FAILED');
  });

  it('fails with OOB_PROTOCOL_INCOMPATIBLE when a decrypted record breaks the pinned schema', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.deliver(client.correlationId, { ...dnsRecord(client.correlationId), protocol: 'ftp' });
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_PROTOCOL_INCOMPATIBLE');
  });

  it('refuses a record that is correlated to another session instead of returning it', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.deliver(client.correlationId, dnsRecord('zzzzzzzzzzzzzzzzzzzz'));
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_PROTOCOL_INCOMPATIBLE');
  });

  it('refuses a poll response that does not match the pinned shape', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.nextPollBody = '{"data":"not-a-list"}';
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_PROTOCOL_INCOMPATIBLE');
  });

  it('refuses a poll response that is not JSON', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.nextPollBody = '<html>';
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_PROTOCOL_INCOMPATIBLE');
  });

  it('refuses records that arrive without an AES key', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.nextPollBody = JSON.stringify({ data: ['AAAA'] });
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_PROTOCOL_INCOMPATIBLE');
  });

  it('refuses a batch above the per-poll cap as an alarm rather than truncating it', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.nextPollBody = JSON.stringify({
      data: Array.from({ length: MAX_RECORDS_PER_POLL + 1 }, () => 'AAAA'),
      aes_key: 'AAAA',
    });
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_POLL_FAILED');
    expect(error.detail).toContain(String(MAX_RECORDS_PER_POLL + 1));
  });

  it('refuses a response body over the size cap', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.nextPollBody = JSON.stringify({
      data: ['A'.repeat(MAX_RESPONSE_BYTES + 1)],
      aes_key: 'AAAA',
    });
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_POLL_FAILED');
    expect(error.detail).toContain('exceeds');
  });

  it('refuses a response that declares an oversized body before reading it', async () => {
    const fetch: Fetch = () =>
      Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: {
            'x-interactsh-version': INTERACTSH_PROTOCOL_VERSION,
            'content-length': String(MAX_RESPONSE_BYTES + 1),
          },
        }),
      );
    const client = new OobClient({ serverUrl: SERVER, token: TOKEN, domain: DOMAIN, fetch });
    const error = await errorOf(client.register());
    expect(error.code).toBe('OOB_REGISTER_FAILED');
    expect(error.detail).toContain('declared');
  });
});

describe('OobClient deregister', () => {
  it('stops further polling for the session', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    await client.deregister();
    const pollsBefore = listener.calls.filter((call) => call.path === '/poll').length;
    const error = await errorOf(client.poll());
    expect(error.code).toBe('OOB_POLL_FAILED');
    expect(listener.calls.filter((call) => call.path === '/poll').length).toBe(pollsBefore);
  });

  it('removes the registration from the listener', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    await client.deregister();
    expect(listener.sessions.size).toBe(0);
  });

  it('drops the session keys and refuses a re-registration (a new session needs a new client)', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    await client.deregister();
    const error = await errorOf(client.register());
    expect(error.code).toBe('OOB_REGISTER_FAILED');
  });

  it('stops polling even when the listener cannot be reached, and reports OOB_DEREGISTER_FAILED', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.register();
    listener.unreachable = true;
    const error = await errorOf(client.deregister());
    expect(error.code).toBe('OOB_DEREGISTER_FAILED');
    expect(error.retryable).toBe(true);
    const pollError = await errorOf(client.poll());
    expect(pollError.code).toBe('OOB_POLL_FAILED');
  });

  it('is a no-op for a session that never registered (it still closes the session)', async () => {
    const listener = new FakeListener();
    const client = makeClient(listener);
    await client.deregister();
    expect(listener.calls).toHaveLength(0);
    expect((await errorOf(client.poll())).code).toBe('OOB_POLL_FAILED');
  });
});
