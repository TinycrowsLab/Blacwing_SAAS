import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { defineConfig, baseEnvSchema, drainConfigLoadEvents } from '@blackwing/config';
import { isAppError } from '@blackwing/errors';

import {
  configureLogging,
  createLogger,
  destinationKind,
  resetLoggingDefaults,
  withContext,
  type TenantLogger,
} from './logger.js';
import { capture } from './testdata/capture.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

afterEach(() => {
  resetLoggingDefaults();
});

describe('createLogger: base fields and format', () => {
  it('writes one valid JSON object per line with time (ISO-8601 UTC), level label, name and pid', () => {
    const out = capture();
    const log = createLogger('api', { destination: out.destination });
    log.info('hello');
    log.warn({ answer: 42 }, 'with fields');

    expect(out.lines).toHaveLength(2);
    for (const line of out.lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(line.trimEnd()).not.toContain('\n');
    }
    const [first, second] = out.records();
    expect(first).toMatchObject({ level: 'info', name: 'api', pid: process.pid, msg: 'hello' });
    expect(String(first?.time)).toMatch(ISO_UTC);
    expect(second).toMatchObject({ level: 'warn', answer: 42, msg: 'with fields' });
  });

  it('puts the base fields first and has no hostname', () => {
    const out = capture();
    createLogger('api', { destination: out.destination }).info('x');
    const keys = Object.keys(out.last());
    expect(keys.slice(0, 4)).toEqual(['level', 'time', 'pid', 'name']);
    expect(keys).not.toContain('hostname');
  });

  it('omits traceId/spanId when no span is active', () => {
    const out = capture();
    createLogger('api', { destination: out.destination }).info('x');
    expect(out.last()).not.toHaveProperty('traceId');
    expect(out.last()).not.toHaveProperty('spanId');
  });

  it('rejects an empty name', () => {
    expect(() => createLogger('')).toThrow(/non-empty/);
    expect(() => createLogger('   ')).toThrow(/non-empty/);
  });
});

describe('levels', () => {
  it('defaults to info', () => {
    const out = capture();
    const log = createLogger('api', { destination: out.destination });
    log.debug('hidden');
    log.info('shown');
    expect(out.records().map((r) => r.msg)).toEqual(['shown']);
    expect(log.level).toBe('info');
  });

  it('takes the level from LOG_LEVEL in config through configureLogging', () => {
    const config = defineConfig(baseEnvSchema, {
      source: { NODE_ENV: 'test', LOG_LEVEL: 'debug' },
    });
    configureLogging({ level: config.LOG_LEVEL, nodeEnv: config.NODE_ENV });
    const out = capture();
    const log = createLogger('api', { destination: out.destination });
    log.trace('hidden');
    log.debug('shown');
    expect(log.level).toBe('debug');
    expect(out.records().filter((r) => r.msg === 'shown')).toHaveLength(1);
    expect(out.records().filter((r) => r.msg === 'hidden')).toHaveLength(0);
  });

  it('lets a single logger override the process-wide level', () => {
    configureLogging({ level: 'error' });
    const out = capture();
    const log = createLogger('api', { destination: out.destination, level: 'warn' });
    log.warn('shown');
    expect(out.records()).toHaveLength(1);
  });

  it('silent emits nothing', () => {
    const out = capture();
    const log = createLogger('api', { destination: out.destination, level: 'silent' });
    log.fatal('nothing');
    expect(out.lines).toHaveLength(0);
  });

  it('fails fast on invalid settings with a ValidationError', () => {
    const attempts: (() => void)[] = [
      () => {
        configureLogging({ level: 'loud' as never });
      },
      () => {
        configureLogging({ nodeEnv: 'prod' as never });
      },
      () => {
        configureLogging({ maxFieldBytes: 10 });
      },
      () => {
        configureLogging({ maxFieldBytes: 1.5 });
      },
      () => {
        configureLogging({ maxDepth: 0 });
      },
      () => {
        configureLogging({ maxCollectionItems: 100_000 });
      },
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (err) {
        caught = err;
      }
      expect(isAppError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('fatal', () => {
  it('flushes the destination synchronously after a fatal line, and only then', () => {
    const out = capture();
    const log = createLogger('api', { destination: out.destination });
    log.error('not flushed');
    expect(out.flushes()).toBe(0);
    log.fatal('flushed');
    expect(out.flushes()).toBe(1);
    expect(out.last()).toMatchObject({ level: 'fatal', msg: 'flushed' });
    withContext(log, { tenantId: 't1' }).fatal('child flushes too');
    expect(out.flushes()).toBe(2);
  });

  it('survives a destination whose flushSync throws', () => {
    const lines: string[] = [];
    const destination = {
      write: (line: string) => {
        lines.push(line);
      },
      flushSync: () => {
        throw new Error('not ready');
      },
    };
    const log = createLogger('api', { destination });
    expect(() => {
      log.fatal('boom');
    }).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('withContext and child loggers', () => {
  it('binds tenantId, runId and sessionId on every line, inherited by children', () => {
    const out = capture();
    const root = createLogger('worker', { destination: out.destination });
    const scoped = withContext(root, { tenantId: 'tnt-1', runId: 'run_1', sessionId: 'sess_1' });
    scoped.info('a');
    scoped.child({ component: 'validator' }).info('b');
    withContext(scoped, { runId: 'run_1' }).info('c');

    const [a, b, c] = out.records();
    for (const record of [a, b, c]) {
      expect(record).toMatchObject({
        tenantId: 'tnt-1',
        runId: 'run_1',
        sessionId: 'sess_1',
        name: 'worker',
      });
    }
    expect(b).toMatchObject({ component: 'validator' });
    expect(c?.msg).toBe('c');
  });

  it('ignores empty and absent context values', () => {
    const out = capture();
    withContext(createLogger('w', { destination: out.destination }), {
      tenantId: '',
      runId: 'run_2',
    }).info('x');
    expect(out.last()).not.toHaveProperty('tenantId');
    expect(out.last()).toMatchObject({ runId: 'run_2' });
  });

  it('re-binding a key replaces it instead of emitting a duplicate key', () => {
    const out = capture();
    const tenantA = withContext(
      createLogger('w', { destination: out.destination, level: 'debug' }),
      {
        tenantId: 'tenant-a',
        runId: 'run_a',
      },
    );
    const tenantB = withContext(tenantA, { tenantId: 'tenant-b' });
    tenantB.debug('switched');
    const line = out.lines[0] ?? '';
    expect(line.match(/"tenantId"/g)).toHaveLength(1);
    expect(out.last()).toMatchObject({ tenantId: 'tenant-b', runId: 'run_a', level: 'debug' });
    // The original logger is unchanged.
    tenantA.info('still a');
    expect(out.last()).toMatchObject({ tenantId: 'tenant-a' });
  });

  it('keeps the name fixed: a name binding is dropped rather than duplicated', () => {
    const out = capture();
    createLogger('api', { destination: out.destination }).child({ name: 'other' }).info('x');
    expect(out.lines[0]?.match(/"name"/g)).toHaveLength(1);
    expect(out.last().name).toBe('api');
  });

  it('types a tenant-bound logger as TenantLogger', () => {
    const out = capture();
    const root = createLogger('db', { destination: out.destination });
    const dataPath = (log: TenantLogger): void => {
      log.info('query');
    };
    dataPath(withContext(root, { tenantId: 'tnt-9' }));
    // @ts-expect-error a logger without tenant context is not a TenantLogger
    dataPath(root);
    expect(out.records().every((r) => r.tenantId === 'tnt-9' || r.tenantId === undefined)).toBe(
      true,
    );
  });
});

describe('destination', () => {
  it('uses the pretty transport only in development; JSON on stdout everywhere else', () => {
    expect(destinationKind('development', false)).toBe('pretty');
    expect(destinationKind('test', false)).toBe('stdout');
    expect(destinationKind('staging', false)).toBe('stdout');
    expect(destinationKind('production', false)).toBe('stdout');
    expect(destinationKind(undefined, false)).toBe('stdout');
    expect(destinationKind('development', true)).toBe('custom');
  });
});

describe('config.loaded events', () => {
  it('are drained and logged at debug by the first logger created', () => {
    drainConfigLoadEvents();
    defineConfig(baseEnvSchema, { source: { NODE_ENV: 'test' } });
    const out = capture();
    createLogger('api', { destination: out.destination, level: 'debug' });
    expect(out.last()).toMatchObject({
      level: 'debug',
      msg: 'config.loaded',
      nodeEnv: 'test',
      keys: ['LOG_LEVEL', 'NODE_ENV', 'TLS_VERIFY'],
    });
    expect(drainConfigLoadEvents()).toHaveLength(0);
  });
});

describe('no console', () => {
  it("the package's product sources never call console.*", () => {
    const srcDir = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => join(srcDir, file));
    expect(sources.length).toBeGreaterThan(3);
    for (const file of sources) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/\bconsole\s*\./);
    }
  });
});
