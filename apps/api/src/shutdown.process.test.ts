// Integration: the real entry point in a child process (via tsx), driven over real sockets. Covers boot
// refusal on missing env, and SIGTERM draining in-flight requests within API_SHUTDOWN_GRACE_MS.
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { CONFIG_EXIT_CODE } from '@blackwing/config';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url));
const MAIN = fileURLToPath(new URL('main.ts', import.meta.url));
const SLOW_SERVER = fileURLToPath(new URL('testdata/slow-server.ts', import.meta.url));
const STARTUP_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

interface Child {
  readonly process: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  await once(server, 'close');
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function start(entry: string, env: Record<string, string>): Child {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: APP_DIR,
    // Only what the child needs: never inherit the parent's environment wholesale.
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });
  return { process: child, stdout: () => out, stderr: () => err, exited };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the child');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function messages(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => (JSON.parse(line) as { msg?: string }).msg ?? '');
}

async function startServer(graceMs: number): Promise<{ child: Child; base: string }> {
  const port = await freePort();
  const child = start(SLOW_SERVER, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    WEB_ORIGIN: 'http://localhost:3000',
    API_HOST: '127.0.0.1',
    API_PORT: String(port),
    API_SHUTDOWN_GRACE_MS: String(graceMs),
  });
  await waitFor(
    () => child.stdout().includes('"api.listening"') || child.process.exitCode !== null,
    STARTUP_TIMEOUT_MS,
  );
  expect(child.process.exitCode, child.stderr()).toBeNull();
  return { child, base: `http://127.0.0.1:${String(port)}` };
}

describe('process boot', () => {
  it(
    'aborts boot with CONFIG_INVALID and a non-zero exit when a required env var is missing',
    async () => {
      const child = start(MAIN, { WEB_ORIGIN: 'http://localhost:3000' });
      const code = await child.exited;
      expect(code).toBe(CONFIG_EXIT_CODE);
      expect(child.stderr()).toContain('CONFIG_INVALID');
      expect(child.stderr()).toContain('NODE_ENV');
      expect(messages(child.stdout())).toContain('api.config_invalid');
      expect(child.stdout()).not.toContain('api.listening');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('graceful shutdown', () => {
  it(
    'drains an in-flight request on SIGTERM, refuses new connections, and exits 0 within the grace window',
    async () => {
      const graceMs = 5000;
      const { child, base } = await startServer(graceMs);
      expect((await fetch(`${base}/v1`)).status).toBe(200);

      const inFlight = fetch(`${base}/v1/slow?ms=1000`, { headers: { connection: 'close' } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const signalledAt = Date.now();
      child.process.kill('SIGTERM');
      await waitFor(() => child.stdout().includes('api.shutdown.draining'), graceMs);
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(fetch(`${base}/v1`)).rejects.toThrow();

      const response = await inFlight;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ waitedMs: 1000 });

      expect(await child.exited).toBe(0);
      expect(Date.now() - signalledAt).toBeLessThan(graceMs);
      const logged = messages(child.stdout());
      expect(logged).toContain('api.shutdown.complete');
      expect(logged).not.toContain('api.shutdown.grace_elapsed');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'cuts requests still running when the grace window elapses, then exits 0',
    async () => {
      const graceMs = 300;
      const { child, base } = await startServer(graceMs);
      const stuck = fetch(`${base}/v1/slow?ms=30000`).then(
        () => 'answered',
        () => 'cut',
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      const signalledAt = Date.now();
      child.process.kill('SIGTERM');

      expect(await child.exited).toBe(0);
      expect(Date.now() - signalledAt).toBeLessThan(graceMs + 2000);
      expect(await stuck).toBe('cut');
      expect(messages(child.stdout())).toContain('api.shutdown.grace_elapsed');
    },
    TEST_TIMEOUT_MS,
  );
});
