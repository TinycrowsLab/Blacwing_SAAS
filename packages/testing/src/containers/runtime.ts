import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  GenericContainer,
  getContainerRuntimeClient,
  type StartedTestContainer,
  type WaitStrategy,
} from 'testcontainers';

import { readTestEnv, resolveReuse, type TestEnv } from './env.js';
import { isDigestPinned } from './images.js';

import type { Readable } from 'node:stream';

/** Options every `with*` helper accepts. */
export interface ContainerOptions {
  /** Reuse the container across test runs (dev only; forced off in CI). Defaults to `BW_TESTCONTAINERS_REUSE`. */
  readonly reuse?: boolean;
  /** How long to wait for the service to become ready. */
  readonly startupTimeoutMs?: number;
  /** Override the pinned image (must still be digest-pinned). Meant for DEVENV alignment checks. */
  readonly image?: string;
}

/** Default wait-for-ready budget per container. Image pulls on a cold cache dominate it. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
/** How many recent container log lines are kept for failure reports. */
export const LOG_TAIL_LINES = 200;

/** Docker (or another container runtime) cannot be reached. */
export class DockerUnavailableError extends Error {
  readonly code = 'DOCKER_UNAVAILABLE' as const;

  constructor(options?: { cause?: unknown }) {
    super(
      [
        'Integration tests need a container runtime, but Docker is not reachable.',
        'Start Docker (or set DOCKER_HOST to a reachable daemon) and re-run `pnpm test:int`.',
        'Unit tests (`pnpm test`) never need Docker: integration tests live in *.int.test.ts files and run only under `pnpm test:int`.',
      ].join(' '),
      options,
    );
    this.name = 'DockerUnavailableError';
  }
}

/** A container did not become ready in time, or exited. Carries its recent logs. */
export class ContainerStartError extends Error {
  readonly code = 'CONTAINER_START_FAILED' as const;
  readonly service: string;
  readonly image: string;
  readonly logs: string;

  constructor(service: string, image: string, logs: string, options?: { cause?: unknown }) {
    const cause = options?.cause instanceof Error ? options.cause.message : 'unknown error';
    super(
      `${service} container (${image}) failed to start: ${cause}\n----- ${service} container logs (most recent) -----\n${logs || '(no output)'}`,
      options,
    );
    this.name = 'ContainerStartError';
    this.service = service;
    this.image = image;
    this.logs = logs;
  }
}

/** A started service is configured in a way that would make isolation tests meaningless. Fail closed. */
export class UnsafeTestEnvironmentError extends Error {
  readonly code = 'UNSAFE_TEST_ENVIRONMENT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTestEnvironmentError';
  }
}

/** Probes the container runtime; resolves when it is usable. */
export type DockerProbe = () => Promise<unknown>;

const defaultProbe: DockerProbe = () => getContainerRuntimeClient();
let dockerReady: Promise<void> | undefined;

/**
 * Resolves when a container runtime is reachable, otherwise throws {@link DockerUnavailableError}
 * with an actionable message. The default probe's success is cached for the process.
 */
export async function ensureDockerAvailable(probe?: DockerProbe): Promise<void> {
  if (probe === undefined && dockerReady !== undefined) return dockerReady;
  const attempt = (async (): Promise<void> => {
    try {
      await (probe ?? defaultProbe)();
    } catch (error) {
      throw new DockerUnavailableError({ cause: error });
    }
  })();
  if (probe === undefined) {
    dockerReady = attempt;
    attempt.catch(() => {
      dockerReady = undefined;
    });
  }
  return attempt;
}

/** True when a container runtime is reachable (never throws). */
export async function isDockerAvailable(probe?: DockerProbe): Promise<boolean> {
  try {
    await ensureDockerAvailable(probe);
    return true;
  } catch {
    return false;
  }
}

/** Keeps the last `limit` lines of a container's output. */
export class LogTail {
  readonly #lines: string[] = [];
  readonly #limit: number;
  #partial = '';

  constructor(limit = LOG_TAIL_LINES) {
    this.#limit = limit;
  }

  push(chunk: string): void {
    const parts = (this.#partial + chunk).split(/\r?\n/);
    this.#partial = parts.pop() ?? '';
    for (const line of parts) {
      this.#lines.push(line);
      if (this.#lines.length > this.#limit) this.#lines.shift();
    }
  }

  attach(stream: Readable): void {
    stream.on('data', (data: Buffer | string) => {
      this.push(typeof data === 'string' ? data : data.toString('utf8'));
    });
  }

  toString(): string {
    return [...this.#lines, ...(this.#partial === '' ? [] : [this.#partial])]
      .slice(-this.#limit)
      .join('\n');
  }
}

const SECRET_FILE = 'testcontainers.secret';
/** 256-bit per-developer secret. */
const SECRET_BYTES = 32;
/** Container credentials: 192 bits, rendered as 48 hex characters. */
const CREDENTIAL_BYTES = 24;
/** Per-call suffixes: 48 bits, 12 hex characters. */
const SUFFIX_BYTES = 6;

function cacheDir(env: TestEnv): string {
  return path.join(env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache'), 'blackwing');
}

/**
 * The per-developer secret that reusable containers derive their credentials from. It lives outside
 * the repository (`~/.cache/blackwing/testcontainers.secret`, mode 0600) and is created on first use.
 */
function reuseSecret(env: TestEnv): Buffer {
  const dir = cacheDir(env);
  const file = path.join(dir, SECRET_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, randomBytes(SECRET_BYTES).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const value = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new UnsafeTestEnvironmentError(
      `${file} is malformed; delete it and re-run (it is recreated automatically)`,
    );
  }
  return Buffer.from(value, 'hex');
}

/**
 * A credential for a test container. Throwaway containers get fresh random values. Reused containers
 * need values that are stable across runs (the reuse hash covers the container's environment), so they
 * are derived from the per-developer secret: never committed, never shared between hosts.
 */
export function containerCredential(
  purpose: string,
  reuse: boolean,
  env: TestEnv = readTestEnv(),
): string {
  if (!reuse) return randomBytes(CREDENTIAL_BYTES).toString('hex');
  return createHmac('sha256', reuseSecret(env))
    .update(`blackwing-testcontainers:${purpose}`)
    .digest('hex')
    .slice(0, CREDENTIAL_BYTES * 2);
}

/** A random lowercase suffix for per-call databases, buckets and key prefixes. */
export function uniqueSuffix(): string {
  return randomBytes(SUFFIX_BYTES).toString('hex');
}

/** Everything {@link startContainer} needs. */
export interface ContainerSpec {
  readonly service: string;
  readonly image: string;
  readonly ports: readonly number[];
  readonly env?: Readonly<Record<string, string>>;
  readonly command?: readonly string[];
  readonly tmpfs?: Readonly<Record<string, string>>;
  readonly wait: WaitStrategy;
  readonly reuse: boolean;
  readonly startupTimeoutMs: number;
}

/** A started container plus its log tail. */
export interface StartedService {
  readonly service: string;
  readonly containerId: string;
  readonly container: StartedTestContainer;
  readonly reused: boolean;
  /** Most recent container output (for failure reports). */
  logs(): string;
  /** Stops and removes the container, unless it is reused (then it is left running for the next run). */
  stop(): Promise<void>;
}

/** Labels every container the helpers start, so leaked ones are easy to find (`docker ps --filter label=…`). */
export const CONTAINER_LABEL = 'org.blackwing.testing.service';

/**
 * Starts a container with a wait-for-ready strategy and timeout, capturing its logs. On failure the
 * error carries the log tail (Testcontainers removes a container that never became ready).
 */
export async function startContainer(spec: ContainerSpec): Promise<StartedService> {
  await ensureDockerAvailable();
  const tail = new LogTail();
  let builder = new GenericContainer(spec.image)
    .withExposedPorts(...spec.ports)
    .withEnvironment({ ...spec.env })
    .withLabels({ [CONTAINER_LABEL]: spec.service })
    .withWaitStrategy(spec.wait)
    .withStartupTimeout(spec.startupTimeoutMs)
    .withLogConsumer((stream) => {
      tail.attach(stream);
    });
  if (spec.command !== undefined) builder = builder.withCommand([...spec.command]);
  if (spec.tmpfs !== undefined) builder = builder.withTmpFs({ ...spec.tmpfs });
  if (spec.reuse) builder = builder.withReuse();

  let container: StartedTestContainer;
  try {
    container = await builder.start();
  } catch (error) {
    throw new ContainerStartError(spec.service, spec.image, tail.toString(), { cause: error });
  }
  return {
    service: spec.service,
    containerId: container.getId(),
    container,
    reused: spec.reuse,
    logs: () => tail.toString(),
    stop: async () => {
      if (!spec.reuse) await container.stop({ remove: true, removeVolumes: true });
    },
  };
}

/** Resolves the image, reuse flag and timeout shared by every helper. */
export function resolveContainerOptions(
  options: ContainerOptions,
  pinned: string,
): { image: string; reuse: boolean; startupTimeoutMs: number } {
  const image = options.image ?? pinned;
  if (!isDigestPinned(image)) {
    throw new UnsafeTestEnvironmentError(`test images must be pinned by digest (got ${image})`);
  }
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new RangeError('startupTimeoutMs must be a positive integer');
  }
  return { image, reuse: resolveReuse(options.reuse), startupTimeoutMs };
}
