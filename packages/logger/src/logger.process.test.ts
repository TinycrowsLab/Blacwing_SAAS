// End-to-end tests: a real service in a child process boots config and the logger and writes to the
// real stdout (synchronous stdout in test/staging/production, the pino-pretty worker in development).
//
// The child runs plain JavaScript: `beforeAll` transpiles this package's sources (no type checking;
// `pnpm typecheck` does that) into a scratch directory under the package's node_modules, so `pino` and
// `@opentelemetry/api` resolve exactly as they do for the package. The workspace dependencies
// (`@blackwing/config`, `@blackwing/errors`) export TypeScript sources, so they are transpiled into the
// scratch directory's own node_modules, and their third-party dependency (`zod`) is linked next to them.
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const cacheDir = join(srcDir, '..', 'node_modules', '.cache');
/** Generous: the full workspace suite runs many packages in parallel on a shared machine. */
const CHILD_TIMEOUT_MS = 30_000;

const WORKSPACE_DEPENDENCIES = ['@blackwing/config', '@blackwing/errors'] as const;
const LINKED_DEPENDENCIES = ['zod'] as const;

const API_TOKEN = 'api-token-e2e-0201';
const CLIENT_PAT = 'bw_pat_e2eClientToken0201';

let buildDir = '';

function productSources(dir: string, recursive: boolean): string[] {
  return readdirSync(dir, { recursive, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => join(dir, file));
}

function transpileTree(rootDir: string, files: readonly string[], outDir: string): void {
  for (const fileName of files) {
    const { outputText } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
      fileName,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2023,
        verbatimModuleSyntax: true,
        sourceMap: false,
      },
    });
    const target = join(outDir, relative(rootDir, fileName)).replace(/\.ts$/, '.js');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, outputText);
  }
}

/** Directory of an installed package, resolved the way `fromDir` would resolve it. */
function packageDir(dependency: string, fromDir: string): string {
  const entry = createRequire(join(fromDir, 'package.json')).resolve(dependency);
  const marker = `${sep}node_modules${sep}${dependency.split('/').join(sep)}${sep}`;
  const index = entry.lastIndexOf(marker);
  if (index < 0) throw new Error(`cannot locate the ${dependency} package directory`);
  return entry.slice(0, index + marker.length - 1);
}

beforeAll(() => {
  mkdirSync(cacheDir, { recursive: true });
  buildDir = mkdtempSync(join(cacheDir, 'logger-e2e-'));
  transpileTree(srcDir, productSources(srcDir, true), buildDir);
  writeFileSync(join(buildDir, 'package.json'), '{ "type": "module" }\n');
  const require = createRequire(import.meta.url);
  for (const dependency of WORKSPACE_DEPENDENCIES) {
    const entryDir = dirname(require.resolve(dependency));
    const depDir = join(buildDir, 'node_modules', ...dependency.split('/'));
    transpileTree(entryDir, productSources(entryDir, false), depDir);
    writeFileSync(
      join(depDir, 'package.json'),
      `${JSON.stringify({ name: dependency, type: 'module', exports: './index.js' })}\n`,
    );
    for (const linked of LINKED_DEPENDENCIES) {
      const link = join(buildDir, 'node_modules', linked);
      try {
        symlinkSync(packageDir(linked, join(entryDir, '..')), link, 'dir');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  }
}, 60_000);

afterAll(() => {
  if (buildDir !== '') rmSync(buildDir, { recursive: true, force: true });
});

function runApp(
  scenario: string,
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [join(buildDir, 'testdata', 'child-app.js'), scenario],
    {
      // Only what the child needs: never inherit the parent's environment wholesale.
      env: { PATH: process.env.PATH ?? '', API_TOKEN, CLIENT_PAT, ...env },
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
    },
  );
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectNoSecrets(output: string): void {
  for (const leak of [
    API_TOKEN,
    CLIENT_PAT,
    'e2eClientToken0201',
    'client-session-0201',
    'server-issued-session-0201',
    'dev-password-0301',
  ]) {
    expect(output).not.toContain(leak);
  }
}

describe('logger in a real process', { timeout: CHILD_TIMEOUT_MS + 5_000 }, () => {
  it('flushes a fatal line synchronously and in order, even when the process exits right after', () => {
    const { status, stdout, stderr } = runApp('fatal-exit', { NODE_ENV: 'production' });
    expect(stderr).toBe('');
    expect(status).toBe(70);
    const lines = jsonLines(stdout);
    expect(lines).toHaveLength(501);
    expect(lines.slice(0, 500).map((line) => line.attempt)).toEqual(
      Array.from({ length: 500 }, (_, i) => i + 1),
    );
    expect(lines[500]).toMatchObject({
      level: 'fatal',
      name: 'child-app',
      msg: 'cannot continue: upstream rejected [REDACTED]',
    });
    expectNoSecrets(stdout);
  });

  it("redacts a service's request log end to end: bearer token, cookies, query secret, response cookie", () => {
    const { status, stdout, stderr } = runApp('http', {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
    });
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const lines = jsonLines(stdout);
    const received = lines.find((line) => line.msg === 'request received');
    const completed = lines.find((line) => line.msg === 'request completed');
    expect(received).toMatchObject({
      level: 'info',
      name: 'child-app',
      tenantId: 'tnt_demo',
      runId: 'run_demo',
      req: {
        method: 'GET',
        url: '/v1/runs?api_token=[REDACTED]',
        headers: {
          authorization: '[REDACTED]',
          cookie: '[REDACTED]',
          'x-request-note': 'forwarded [REDACTED]',
        },
        remoteAddress: '127.0.0.1',
      },
    });
    expect(completed).toMatchObject({
      res: { statusCode: 204, headers: { 'set-cookie': '[REDACTED]' } },
    });
    expectNoSecrets(stdout);
  });

  it('writes pretty, still-redacted output in development only', () => {
    const dev = runApp('pretty', { NODE_ENV: 'development' });
    expect(dev.status).toBe(0);
    expect(dev.stdout).toContain('pretty line');
    expect(dev.stdout).toContain('INFO');
    expect(() => {
      JSON.parse(dev.stdout.split('\n')[0] ?? '');
    }).toThrow();
    expect(dev.stdout).toContain('[REDACTED]');
    expectNoSecrets(dev.stdout);

    const prod = runApp('pretty', { NODE_ENV: 'staging' });
    expect(prod.status).toBe(0);
    expect(jsonLines(prod.stdout)[0]).toMatchObject({ msg: 'pretty line', password: '[REDACTED]' });
    expectNoSecrets(prod.stdout);
  });
});
