import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ValidationError } from '@blackwing/errors';

import {
  createQueue,
  createWorker,
  DEFAULT_JOB_ATTEMPTS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  defaultJobOptions,
  getBullConnection,
} from './bull.js';
import { createOtelQueueMetrics } from './metrics.js';

const TENANT = '0190f2a4-7c1e-7d3a-9b8e-2f4a6c8d0e1f';
const payload = z.object({ to: z.string(), n: z.number().int() });
const connection = { host: '127.0.0.1', port: 1 };

describe('default job options', () => {
  it('match the issue: five attempts, exponential backoff from 1 s, completed kept 1 h, failed kept', () => {
    expect(DEFAULT_JOB_ATTEMPTS).toBe(5);
    expect(defaultJobOptions()).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: false,
    });
  });

  it('returns a fresh object each time so callers cannot mutate the defaults', () => {
    const first = defaultJobOptions();
    first.attempts = 99;
    expect(defaultJobOptions().attempts).toBe(5);
  });

  it('caps the payload at 256 KiB by default', () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(262_144);
  });
});

describe('getBullConnection', () => {
  it('parses host, port and credentials from REDIS_URL and never retries a command forever', () => {
    const conn = getBullConnection({
      redisUrl: 'redis://:s%40cret@valkey.internal:6380',
      prefix: 'bw',
      workerConcurrency: 10,
    });
    expect(conn).toMatchObject({ host: 'valkey.internal', port: 6380, password: 's@cret' });
    expect(conn).toHaveProperty('maxRetriesPerRequest', null);
    expect(conn).not.toHaveProperty('username');
    expect(conn).not.toHaveProperty('tls');
  });

  it('uses port 6379 when none is given and TLS for rediss:', () => {
    const conn = getBullConnection({
      redisUrl: 'rediss://valkey',
      prefix: 'bw',
      workerConcurrency: 10,
    });
    expect(conn).toMatchObject({ host: 'valkey', port: 6379, tls: {} });
    expect(conn).not.toHaveProperty('password');
  });

  it('backs reconnects off linearly up to a 5 s cap', () => {
    const conn = getBullConnection({
      redisUrl: 'redis://valkey:6379',
      prefix: 'bw',
      workerConcurrency: 10,
    });
    const retry = (conn as { retryStrategy: (n: number) => number }).retryStrategy;
    expect(retry(1)).toBe(200);
    expect(retry(10)).toBe(2000);
    expect(retry(1000)).toBe(5000);
  });
});

describe('scope checks run before any connection is opened', () => {
  it('refuses a queue without a tenant (no unscoped queues)', () => {
    expect(() => createQueue('email-send', { tenantId: '', payload, connection })).toThrow(
      ValidationError,
    );
    expect(() => createQueue('email-send', { tenantId: 'acme', payload, connection })).toThrow(
      ValidationError,
    );
  });

  it('refuses queue names that could escape a tenant key prefix', () => {
    for (const bad of ['a:b', 'Email', '', '../x', 'x'.repeat(64)]) {
      expect(() => createQueue(bad, { tenantId: TENANT, payload, connection })).toThrow(
        ValidationError,
      );
    }
  });

  it('refuses a worker concurrency that is not a positive integer', () => {
    expect(() =>
      createWorker('email-send', () => Promise.resolve(), {
        tenantId: TENANT,
        payload,
        connection,
        concurrency: 0,
      }),
    ).toThrow(ValidationError);
  });
});

describe('OTel metrics adapter', () => {
  it('records completed, failed and sampled values without throwing on the no-op meter', () => {
    const metrics = createOtelQueueMetrics();
    expect(() => {
      metrics.completed('email-send');
      metrics.failed('email-send');
      metrics.sampled('email-send', { active: 1, waiting: 2, depth: 3 });
    }).not.toThrow();
  });
});
