import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseTemporalConfig, type TemporalConfig } from '@blackwing/config';
import { AppError } from '@blackwing/errors';

import { createDataConverter } from './data-converter.js';
import {
  CONNECT_MAX_ATTEMPTS,
  closeTemporal,
  getTemporalClient,
  getTemporalConnection,
  type TemporalClientOptions,
} from './temporal-client.js';

import type { Connection, ConnectionOptions } from '@temporalio/client';

const devConfig: TemporalConfig = parseTemporalConfig({ NODE_ENV: 'test' });

function fakeConnection(describe: () => Promise<unknown> = () => Promise.resolve({})) {
  const close = vi.fn(() => Promise.resolve());
  const describeNamespace = vi.fn(describe);
  const connection = { close, workflowService: { describeNamespace } } as unknown as Connection;
  return { connection, close, describeNamespace };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_APP_ERROR';
  }
  return undefined;
}

afterEach(async () => {
  await closeTemporal();
});

describe('connection reuse', () => {
  it('opens one connection for 100 concurrent and sequential calls', async () => {
    const { connection } = fakeConnection();
    const connect = vi.fn(() => Promise.resolve(connection));
    const options: TemporalClientOptions = { config: devConfig, connect };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => getTemporalConnection(options)),
    );
    await getTemporalClient(options);
    await getTemporalConnection(options);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
  });

  it('returns one client bound to the configured namespace', async () => {
    const { connection } = fakeConnection();
    const options: TemporalClientOptions = {
      config: { ...devConfig, namespace: 'bw-test' },
      connect: () => Promise.resolve(connection),
    };
    const client = await getTemporalClient(options);
    expect(client.options.namespace).toBe('bw-test');
    expect(client.options.connection).toBe(connection);
    expect(await getTemporalClient(options)).toBe(client);
  });

  it('closes the connection and opens a fresh one afterwards', async () => {
    const first = fakeConnection();
    const second = fakeConnection();
    const connect = vi
      .fn<(o: ConnectionOptions) => Promise<Connection>>()
      .mockResolvedValueOnce(first.connection)
      .mockResolvedValueOnce(second.connection);
    const options: TemporalClientOptions = { config: devConfig, connect };
    await getTemporalConnection(options);
    await closeTemporal();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(await getTemporalConnection(options)).toBe(second.connection);
    await closeTemporal();
    await closeTemporal();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('closeTemporal is a no-op when nothing was opened or the open failed', async () => {
    await expect(closeTemporal()).resolves.toBeUndefined();
    const connect = vi.fn(() => Promise.reject(new Error('down')));
    await codeOf(getTemporalConnection({ config: devConfig, connect, sleep: () => Promise.resolve() }));
    await expect(closeTemporal()).resolves.toBeUndefined();
  });
});

describe('TLS', () => {
  const tlsConfig: TemporalConfig = {
    address: 'temporal.internal:7233',
    namespace: 'blackwing',
    tls: { enabled: true, clientCertPath: '/tls/c.pem', clientKeyPath: '/tls/k.pem' },
  };

  it('passes the client certificate pair through when TLS is enabled', async () => {
    const { connection } = fakeConnection();
    const connect = vi.fn<(options: ConnectionOptions) => Promise<Connection>>(() => Promise.resolve(connection));
    const files: Record<string, string> = { '/tls/c.pem': 'CERT', '/tls/k.pem': 'KEY' };
    await getTemporalConnection({
      config: tlsConfig,
      connect,
      readFile: (path) => Promise.resolve(Buffer.from(files[path] ?? '')),
    });
    const passed = connect.mock.calls[0]?.[0];
    expect(passed?.address).toBe('temporal.internal:7233');
    expect(passed?.tls).toEqual({
      clientCertPair: { crt: Buffer.from('CERT'), key: Buffer.from('KEY') },
    });
  });

  it('does not set TLS options when disabled', async () => {
    const { connection } = fakeConnection();
    const connect = vi.fn<(options: ConnectionOptions) => Promise<Connection>>(() => Promise.resolve(connection));
    await getTemporalConnection({ config: devConfig, connect });
    expect(connect.mock.calls[0]?.[0]).toEqual({ address: 'temporal:7233' });
  });

  it('throws TEMPORAL_TLS_MISCONFIGURED when a certificate file is unreadable', async () => {
    const connect = vi.fn();
    const code = await codeOf(
      getTemporalConnection({
        config: tlsConfig,
        connect,
        readFile: () => Promise.reject(new Error('ENOENT')),
      }),
    );
    expect(code).toBe('TEMPORAL_TLS_MISCONFIGURED');
    expect(connect).not.toHaveBeenCalled();
  });

  it('throws TEMPORAL_TLS_MISCONFIGURED when enabled without cert paths', async () => {
    const code = await codeOf(
      getTemporalConnection({
        config: { ...tlsConfig, tls: { enabled: true } },
        connect: vi.fn(),
      }),
    );
    expect(code).toBe('TEMPORAL_TLS_MISCONFIGURED');
  });
});

describe('failure handling', () => {
  it('retries with capped backoff, then throws TEMPORAL_UNAVAILABLE', async () => {
    const connect = vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED')));
    const sleeps: number[] = [];
    const code = await codeOf(
      getTemporalConnection({
        config: devConfig,
        connect,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      }),
    );
    expect(code).toBe('TEMPORAL_UNAVAILABLE');
    expect(connect).toHaveBeenCalledTimes(CONNECT_MAX_ATTEMPTS);
    expect(sleeps).toEqual([200, 400, 800, 1600]);
  });

  it('recovers when Temporal comes up mid-retry', async () => {
    const { connection } = fakeConnection();
    const connect = vi
      .fn<(o: ConnectionOptions) => Promise<Connection>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(connection);
    const result = await getTemporalConnection({
      config: devConfig,
      connect,
      sleep: () => Promise.resolve(),
    });
    expect(result).toBe(connection);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed open: the next call tries again', async () => {
    const { connection } = fakeConnection();
    const connect = vi
      .fn<(o: ConnectionOptions) => Promise<Connection>>()
      .mockRejectedValue(new Error('down'));
    const sleep = () => Promise.resolve();
    expect(await codeOf(getTemporalConnection({ config: devConfig, connect, sleep }))).toBe(
      'TEMPORAL_UNAVAILABLE',
    );
    connect.mockResolvedValue(connection);
    expect(await getTemporalConnection({ config: devConfig, connect, sleep })).toBe(connection);
  });

  it('throws TEMPORAL_NAMESPACE_NOT_FOUND with a remediation hint, without retrying', async () => {
    const { connection, close } = fakeConnection(() =>
      Promise.reject(Object.assign(new Error('Namespace blackwing is not found.'), { code: 5 })),
    );
    const connect = vi.fn(() => Promise.resolve(connection));
    let caught: unknown;
    try {
      await getTemporalConnection({ config: devConfig, connect, sleep: () => Promise.resolve() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('TEMPORAL_NAMESPACE_NOT_FOUND');
    expect((caught as AppError).detail).toContain('temporal operator namespace create blackwing');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('propagates TEMPORAL_CONFIG_INVALID from the environment when no config is injected', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TEMPORAL_ADDRESS', '');
    expect(await codeOf(getTemporalConnection({ connect: vi.fn() }))).toBe(
      'TEMPORAL_CONFIG_INVALID',
    );
  });
});

describe('createDataConverter', () => {
  it('defaults to the SDK converter and slots in a payload codec', () => {
    const base = createDataConverter();
    expect(base.payloadCodecs ?? []).toEqual([]);
    const codec = {
      encode: (payloads: never[]) => Promise.resolve(payloads),
      decode: (payloads: never[]) => Promise.resolve(payloads),
    };
    expect(createDataConverter({ payloadCodec: codec }).payloadCodecs).toEqual([codec]);
  });

  it('is handed to the client', async () => {
    const { connection } = fakeConnection();
    const dataConverter = createDataConverter({
      payloadCodec: { encode: (p) => Promise.resolve(p), decode: (p) => Promise.resolve(p) },
    });
    const client = await getTemporalClient({
      config: devConfig,
      dataConverter,
      connect: () => Promise.resolve(connection),
    });
    expect(client.options.loadedDataConverter.payloadCodecs).toHaveLength(1);
  });
});
