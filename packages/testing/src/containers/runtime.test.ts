// Unit tests for the container helpers' pure parts: no Docker needed.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTestEnv, resolveReuse } from './env.js';
import { isDigestPinned, TEST_IMAGES } from './images.js';
import { withMinio } from './minio.js';
import { withNeo4j } from './neo4j.js';
import { RLS_SQL_FILES, withPostgres } from './postgres.js';
import {
  containerCredential,
  DockerUnavailableError,
  ensureDockerAvailable,
  isDockerAvailable,
  LogTail,
  resolveContainerOptions,
  UnsafeTestEnvironmentError,
} from './runtime.js';
import { withValkey } from './valkey.js';

const env = (values: Record<string, string>) => readTestEnv(values);

describe('Docker availability', () => {
  const unreachable = (): Promise<never> =>
    Promise.reject(new Error('Could not find a working container runtime strategy'));

  it('throws a clear, actionable error when Docker is not reachable', async () => {
    const error: unknown = await ensureDockerAvailable(unreachable).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DockerUnavailableError);
    const message = (error as DockerUnavailableError).message;
    expect(message).toMatch(/Docker is not reachable/);
    expect(message).toMatch(/Start Docker \(or set DOCKER_HOST/);
    expect(message).toContain('Unit tests (`pnpm test`) never need Docker');
    expect((error as DockerUnavailableError).code).toBe('DOCKER_UNAVAILABLE');
    expect((error as DockerUnavailableError).cause).toBeInstanceOf(Error);
  });

  it('isDockerAvailable reports instead of throwing', async () => {
    await expect(isDockerAvailable(unreachable)).resolves.toBe(false);
    await expect(isDockerAvailable(() => Promise.resolve())).resolves.toBe(true);
  });
});

describe('resolveReuse', () => {
  it.each([
    // [requested, env, expected]
    [undefined, {}, false],
    [true, {}, true],
    [false, { BW_TESTCONTAINERS_REUSE: 'true' }, false],
    [undefined, { BW_TESTCONTAINERS_REUSE: 'true' }, true],
    [undefined, { BW_TESTCONTAINERS_REUSE: '1' }, true],
    [true, { CI: 'true' }, false],
    [undefined, { CI: '1', BW_TESTCONTAINERS_REUSE: 'true' }, false],
    [true, { CI: 'false' }, true],
    [true, { TESTCONTAINERS_REUSE_ENABLE: 'false' }, false],
  ] as const)('requested=%s env=%j -> %s', (requested, values, expected) => {
    expect(resolveReuse(requested, env(values))).toBe(expected);
  });

  it('rejects a malformed reuse flag instead of guessing', () => {
    expect(() => env({ BW_TESTCONTAINERS_REUSE: 'yes' })).toThrow();
  });
});

describe('container credentials', () => {
  let cache = '';
  beforeEach(() => {
    cache = mkdtempSync(path.join(tmpdir(), 'bw-cred-'));
  });
  afterEach(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  it('are fresh random values for throwaway containers', () => {
    const a = containerCredential('x', false, env({ XDG_CACHE_HOME: cache }));
    const b = containerCredential('x', false, env({ XDG_CACHE_HOME: cache }));
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  it('are stable per purpose for reused containers, from a private per-developer secret', () => {
    const e = env({ XDG_CACHE_HOME: cache });
    const a = containerCredential('postgres:bw_app', true, e);
    expect(containerCredential('postgres:bw_app', true, e)).toBe(a);
    expect(containerCredential('postgres:bw_owner', true, e)).not.toBe(a);
    const secret = path.join(cache, 'blackwing', 'testcontainers.secret');
    expect(statSync(secret).mode & 0o777).toBe(0o600);
    expect(readFileSync(secret, 'utf8')).not.toContain(a);
  });

  it('differ between developers (different secrets)', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'bw-cred-other-'));
    try {
      expect(containerCredential('p', true, env({ XDG_CACHE_HOME: cache }))).not.toBe(
        containerCredential('p', true, env({ XDG_CACHE_HOME: other })),
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuse a corrupted secret file', () => {
    containerCredential('p', true, env({ XDG_CACHE_HOME: cache }));
    writeFileSync(path.join(cache, 'blackwing', 'testcontainers.secret'), 'short');
    expect(() => containerCredential('p', true, env({ XDG_CACHE_HOME: cache }))).toThrow(
      UnsafeTestEnvironmentError,
    );
  });
});

describe('image pinning', () => {
  it('pins every test image by sha256 digest', () => {
    for (const [name, reference] of Object.entries(TEST_IMAGES)) {
      expect(isDigestPinned(reference), name).toBe(true);
    }
  });

  it('uses Postgres 16, Valkey 8 and Neo4j 5 Community', () => {
    expect(TEST_IMAGES.postgres).toMatch(/^pgvector\/pgvector:[\d.]+-pg16@/);
    expect(TEST_IMAGES.valkey).toMatch(/^valkey\/valkey:8\./);
    expect(TEST_IMAGES.neo4j).toMatch(/^neo4j:5\.[\d.]+-community@/);
  });

  it('refuses an unpinned override before touching Docker', async () => {
    expect(() => resolveContainerOptions({ image: 'postgres:16' }, TEST_IMAGES.postgres)).toThrow(
      UnsafeTestEnvironmentError,
    );
    await expect(withPostgres({ image: 'postgres:16' })).rejects.toBeInstanceOf(
      UnsafeTestEnvironmentError,
    );
    await expect(withValkey({ image: 'valkey/valkey:8' })).rejects.toBeInstanceOf(
      UnsafeTestEnvironmentError,
    );
    await expect(withMinio({ image: 'minio/minio' })).rejects.toBeInstanceOf(
      UnsafeTestEnvironmentError,
    );
    await expect(withNeo4j({ image: 'neo4j:5' })).rejects.toBeInstanceOf(
      UnsafeTestEnvironmentError,
    );
  });

  it('rejects a non-positive startup timeout', () => {
    expect(() => resolveContainerOptions({ startupTimeoutMs: 0 }, TEST_IMAGES.valkey)).toThrow(
      RangeError,
    );
  });
});

describe('LogTail', () => {
  it('keeps only the most recent lines, joining partial chunks', () => {
    const tail = new LogTail(3);
    tail.push('one\ntw');
    tail.push('o\nthree\nfour\nfi');
    expect(tail.toString()).toBe('three\nfour\nfi');
  });

  it('collects a container log stream', async () => {
    const tail = new LogTail();
    const stream = new PassThrough();
    tail.attach(stream);
    stream.write(Buffer.from('database system is ready\n'));
    stream.end('done');
    await new Promise((resolve) => stream.on('end', resolve).resume());
    expect(tail.toString()).toBe('database system is ready\ndone');
  });
});

describe('reusable RLS role SQL', () => {
  const code = (file: string): string =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
  const roles = code(RLS_SQL_FILES.roles);
  const database = code(RLS_SQL_FILES.database);

  it('creates both roles without BYPASSRLS or SUPERUSER, and keeps the app role out of the owner role', () => {
    expect(roles).toMatch(/ALTER ROLE bw_owner NOSUPERUSER [^;]*NOBYPASSRLS/);
    expect(roles).toMatch(/ALTER ROLE bw_app NOSUPERUSER [^;]*NOBYPASSRLS/);
    expect(roles).toMatch(/REVOKE bw_owner FROM bw_app/);
    // The only mention of the attribute in executable SQL is its negation.
    expect(`${roles}\n${database}`).not.toMatch(/(?<!NO)BYPASSRLS/);
  });

  it('never stores a credential', () => {
    expect(`${roles}\n${database}`).not.toMatch(/PASSWORD\s+'/i);
  });

  it('lets only the owner create objects, and grants the app role usage only', () => {
    expect(database).toMatch(/ALTER SCHEMA public OWNER TO bw_owner/);
    expect(database).toMatch(/REVOKE ALL ON SCHEMA public FROM PUBLIC/);
    expect(database).toMatch(/GRANT USAGE ON SCHEMA public TO bw_app/);
    expect(database).not.toMatch(/GRANT (ALL|CREATE)[^;]*TO bw_app/);
  });
});
