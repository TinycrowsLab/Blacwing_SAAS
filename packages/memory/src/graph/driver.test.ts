import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@blackwing/errors';

import {
  checkGraphHealth,
  closeDriver,
  createNeo4jDriver,
  type CreateNeo4jDriverOptions,
  type GraphLogger,
  type GraphMetrics,
  type GraphRuntime,
  getDriver,
  getGraph,
  withSession,
  withSessionOn,
} from './driver.js';

import type { Neo4jConfig } from './config.js';
import type { AuthTokenManager, Config, Driver, Session } from 'neo4j-driver';

const PASSWORD = 'correct-horse-battery';

const CONFIG: Neo4jConfig = Object.freeze({
  uri: 'bolt://graph.internal:7687',
  username: 'neo4j',
  password: PASSWORD,
  database: 'surface',
  maxPoolSize: 42,
  connectionTimeoutMs: 5000,
  maxTxRetryMs: 15000,
});

type DriverFactory = NonNullable<CreateNeo4jDriverOptions['createDriver']>;

/** The auth manager of the one driver a test created. */
function authOf(calls: readonly { auth: AuthTokenManager }[]): AuthTokenManager {
  const call = calls[0];
  if (call === undefined) throw new Error('no driver was created');
  return call.auth;
}

/** A driver factory that records what the module passed to `neo4j.driver`. */
function capturingFactory(driver: Driver = fakeDriver().driver) {
  const calls: { uri: string; auth: AuthTokenManager; config: Config }[] = [];
  const factory: DriverFactory = (uri, auth, config) => {
    calls.push({ uri, auth, config });
    return driver;
  };
  return { calls, factory };
}

function fakeLogger(): GraphLogger & { lines: string[] } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      lines.push(JSON.stringify({ level, args }));
    };
  return {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

function fakeMetrics(): GraphMetrics & {
  health: boolean[];
  latencies: number[];
  poolCounts: number[];
} {
  const health: boolean[] = [];
  const latencies: number[] = [];
  const poolCounts: number[] = [];
  return {
    health,
    latencies,
    poolCounts,
    healthUp: (up) => health.push(up),
    healthLatencyMs: (ms) => latencies.push(ms),
    poolInUse: (count) => poolCounts.push(count),
  };
}

function fakeSession(run: () => Promise<unknown> = () => Promise.resolve(undefined)) {
  const close = vi.fn(() => Promise.resolve());
  const session = { close, run: vi.fn(run) } as unknown as Session;
  return { session, close };
}

function fakeDriver(overrides: Partial<Pick<Driver, 'session' | 'executeQuery' | 'close'>> = {}) {
  const close = vi.fn(() => Promise.resolve());
  const executeQuery = vi.fn(() => Promise.resolve({ records: [] }));
  const driver = {
    close,
    executeQuery,
    session: vi.fn(() => fakeSession().session),
    ...overrides,
  } as unknown as Driver;
  return { driver, close, executeQuery };
}

function runtimeWith(driver: Driver, logger = fakeLogger(), metrics = fakeMetrics()): GraphRuntime {
  return { driver, database: CONFIG.database, logger, metrics, sessions: { open: 0 } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createNeo4jDriver', () => {
  it('maps the config onto the pool, timeout and retry settings of the driver', () => {
    const { driver } = fakeDriver();
    const { calls, factory } = capturingFactory(driver);
    const result = createNeo4jDriver(CONFIG, { logger: fakeLogger(), createDriver: factory });
    expect(result).toBe(driver);
    expect(calls[0]?.uri).toBe('bolt://graph.internal:7687');
    expect(calls[0]?.config).toMatchObject({
      maxConnectionPoolSize: 42,
      connectionAcquisitionTimeout: 5000,
      connectionTimeout: 5000,
      maxTransactionRetryTime: 15000,
    });
  });

  it('logs creation with the host only: no credentials, no password', () => {
    const logger = fakeLogger();
    createNeo4jDriver(CONFIG, { logger, createDriver: capturingFactory().factory });
    const logged = logger.lines.join('\n');
    expect(logged).toContain('graph.driver.created');
    expect(logged).toContain('graph.internal:7687');
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('"neo4j"');
  });

  it('re-reads the password after the server rejects the old one, so a rotated secret is picked up on reconnect', async () => {
    let password = 'first-password';
    const { calls, factory } = capturingFactory();
    createNeo4jDriver(CONFIG, {
      logger: fakeLogger(),
      resolvePassword: () => Promise.resolve(password),
      createDriver: factory,
    });
    const auth = authOf(calls);
    const stale = await auth.getToken();
    expect(stale).toMatchObject({ scheme: 'basic', credentials: 'first-password' });
    password = 'rotated-password';
    expect(auth.handleSecurityException(stale, 'Neo.ClientError.Security.Unauthorized')).toBe(true);
    expect(await auth.getToken()).toMatchObject({ credentials: 'rotated-password' });
  });

  it('keeps the cached password when the server reports an unrelated security error', async () => {
    let password = 'first-password';
    const { calls, factory } = capturingFactory();
    createNeo4jDriver(CONFIG, {
      logger: fakeLogger(),
      resolvePassword: () => Promise.resolve(password),
      createDriver: factory,
    });
    const auth = authOf(calls);
    const current = await auth.getToken();
    password = 'rotated-password';
    expect(auth.handleSecurityException(current, 'Neo.ClientError.Security.Forbidden')).toBe(false);
    expect(await auth.getToken()).toMatchObject({ credentials: 'first-password' });
  });

  it('defaults to the configured password when no resolver is given', async () => {
    const { calls, factory } = capturingFactory();
    createNeo4jDriver(CONFIG, { logger: fakeLogger(), createDriver: factory });
    expect(await authOf(calls).getToken()).toMatchObject({ credentials: PASSWORD });
  });

  it('forwards driver log lines to the structured logger, tagged with the component', () => {
    const logger = fakeLogger();
    const { calls, factory } = capturingFactory();
    createNeo4jDriver(CONFIG, { logger, createDriver: factory });
    calls[0]?.config.logging?.logger('warn', 'routing table stale');
    const logged = logger.lines.join('\n');
    expect(logged).toContain('routing table stale');
    expect(logged).toContain('neo4j-driver');
  });
});

describe('withSession', () => {
  it('opens a read session on the configured database and closes it', async () => {
    const { session, close } = fakeSession();
    const sessionFn = vi.fn(() => session);
    const runtime = runtimeWith({ session: sessionFn } as unknown as Driver);
    const result = await withSessionOn(runtime, 'READ', () => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(sessionFn).toHaveBeenCalledWith(
      expect.objectContaining({ database: 'surface', defaultAccessMode: 'READ' }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('opens a write session when asked for one', async () => {
    const { session } = fakeSession();
    const sessionFn = vi.fn(() => session);
    await withSessionOn(runtimeWith({ session: sessionFn } as unknown as Driver), 'WRITE', () =>
      Promise.resolve(null),
    );
    expect(sessionFn).toHaveBeenCalledWith(expect.objectContaining({ defaultAccessMode: 'WRITE' }));
  });

  it('closes the session and rethrows when the work fails', async () => {
    const { session, close } = fakeSession();
    const runtime = runtimeWith({ session: () => session } as unknown as Driver);
    await expect(
      withSessionOn(runtime, 'READ', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('maps a pool acquire timeout to a retryable GRAPH_POOL_TIMEOUT, not a hang', async () => {
    const { session, close } = fakeSession();
    const runtime = runtimeWith({ session: () => session } as unknown as Driver);
    const timeout = new Error(
      'Connection acquisition timed out in 5000 ms. Pool status: Active conn count = 42, Idle conn count = 0.',
    );
    const error = await withSessionOn(runtime, 'READ', () => Promise.reject(timeout)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('GRAPH_POOL_TIMEOUT');
    expect((error as AppError).retryable).toBe(true);
    expect((error as AppError).httpStatus).toBe(503);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not reclassify unrelated driver errors as pool timeouts', async () => {
    const { session } = fakeSession();
    const runtime = runtimeWith({ session: () => session } as unknown as Driver);
    const other = new Error('Connection refused');
    await expect(withSessionOn(runtime, 'READ', () => Promise.reject(other))).rejects.toBe(other);
  });

  it('reports the open session count while work runs, and back to zero after success or failure', async () => {
    const { session } = fakeSession();
    const metrics = fakeMetrics();
    const runtime = runtimeWith(
      { session: () => session } as unknown as Driver,
      fakeLogger(),
      metrics,
    );
    await withSessionOn(runtime, 'READ', () => {
      expect(runtime.sessions.open).toBe(1);
      return Promise.resolve(null);
    });
    await withSessionOn(runtime, 'READ', () => Promise.reject(new Error('boom'))).catch(
      () => undefined,
    );
    expect(metrics.poolCounts).toEqual([1, 0, 1, 0]);
    expect(runtime.sessions.open).toBe(0);
  });

  it('uses the process runtime and its configured database when called without a runtime', async () => {
    vi.stubEnv('NEO4J_URI', 'bolt://graph.internal:7687');
    vi.stubEnv('NEO4J_PASSWORD', PASSWORD);
    vi.stubEnv('NEO4J_DATABASE', 'surface');
    const result = await withSession('READ', () => Promise.resolve('ok'));
    expect(result).toBe('ok');
    expect(getGraph().database).toBe('surface');
    expect(getGraph().sessions.open).toBe(0);
    await closeDriver();
  });

  it('fails with GRAPH_CONFIG_MISSING when the process config is incomplete, without opening a session', async () => {
    vi.stubEnv('NEO4J_URI', '');
    vi.stubEnv('NEO4J_PASSWORD', PASSWORD);
    const error = await withSession('WRITE', () => Promise.resolve('never')).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('GRAPH_CONFIG_MISSING');
  });
});

describe('checkGraphHealth', () => {
  it('reports ok with the probe latency and runs RETURN 1 on the configured database', async () => {
    const { driver, executeQuery } = fakeDriver();
    const metrics = fakeMetrics();
    const result = await checkGraphHealth(runtimeWith(driver, fakeLogger(), metrics));
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(executeQuery).toHaveBeenCalledWith('RETURN 1', {}, { database: 'surface' });
    expect(metrics.health).toEqual([true]);
    expect(metrics.latencies).toHaveLength(1);
  });

  it('reports ok false and never throws when the database is down', async () => {
    const { driver } = fakeDriver({
      executeQuery: vi.fn(() =>
        Promise.reject(new Error('connect ECONNREFUSED graph.internal:7687')),
      ),
    });
    const logger = fakeLogger();
    const metrics = fakeMetrics();
    const result = await checkGraphHealth(runtimeWith(driver, logger, metrics));
    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(metrics.health).toEqual([false]);
    expect(logger.lines.join('\n')).toContain('graph.health.down');
  });

  it('logs the error class and code only, never the message that can name a host', async () => {
    const failure = Object.assign(new Error('auth failed for user neo4j with ' + PASSWORD), {
      code: 'Neo.ClientError.Security.Unauthorized',
    });
    const { driver } = fakeDriver({ executeQuery: vi.fn(() => Promise.reject(failure)) });
    const logger = fakeLogger();
    await checkGraphHealth(runtimeWith(driver, logger));
    const logged = logger.lines.join('\n');
    expect(logged).toContain('Neo.ClientError.Security.Unauthorized');
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('auth failed');
  });
});

describe('process singleton', () => {
  const ENV = {
    NEO4J_URI: 'bolt://graph.internal:7687',
    NEO4J_PASSWORD: PASSWORD,
  };

  it('getDriver returns the same driver across calls', async () => {
    vi.stubEnv('NEO4J_URI', ENV.NEO4J_URI);
    vi.stubEnv('NEO4J_PASSWORD', ENV.NEO4J_PASSWORD);
    const first = getDriver();
    expect(getDriver()).toBe(first);
    expect(getGraph().driver).toBe(first);
    await closeDriver();
  });

  it('getDriver fails fast with GRAPH_CONFIG_MISSING when the URI is not set', () => {
    vi.stubEnv('NEO4J_URI', '');
    vi.stubEnv('NEO4J_PASSWORD', ENV.NEO4J_PASSWORD);
    const error = (() => {
      try {
        getDriver();
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('GRAPH_CONFIG_MISSING');
  });

  it('closeDriver is idempotent and safe before any driver exists', async () => {
    await expect(closeDriver()).resolves.toBeUndefined();
    vi.stubEnv('NEO4J_URI', ENV.NEO4J_URI);
    vi.stubEnv('NEO4J_PASSWORD', ENV.NEO4J_PASSWORD);
    getDriver();
    await closeDriver();
    await expect(closeDriver()).resolves.toBeUndefined();
  });
});
