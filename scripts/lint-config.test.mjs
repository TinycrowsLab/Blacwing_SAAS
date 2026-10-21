// Self-tests for the lint and format gate (FOUND-004): eslint.config.mjs, prettier.config.mjs,
// .prettierignore and the lint scripts. The failing fixtures under scripts/fixtures/eslint/ are
// excluded from normal lint runs (they are wrong on purpose); these tests lint them explicitly and
// prove that the rules fire, including the type-aware ones that silently do nothing without type
// information.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';
import prettierRules from 'eslint-config-prettier';
import * as prettier from 'prettier';

import config, { IGNORES } from '../eslint.config.mjs';
import { REPO_ROOT, asArray, asObject, parseJsonObject, readJsonObject } from './test-fixtures.mjs';

const FIXTURES = path.join(REPO_ROOT, 'scripts', 'fixtures', 'eslint');
const PRETTIER_IGNORE = path.join(REPO_ROOT, '.prettierignore');
const ERROR = 2;
const OFF = 0;

/** One linter for the whole file: the project service is expensive to start. */
const eslint = new ESLint({ cwd: REPO_ROOT });
/** Same configuration, but without the global ignores, so the failing fixtures can be linted. */
const unignored = new ESLint({ cwd: REPO_ROOT, ignore: false });

/**
 * Normalises a rule entry of a computed config (`2`, `"error"`, `[2, {...}]`) to a severity.
 * @param {unknown} entry
 * @returns {number}
 */
function severityOf(entry) {
  const level = Array.isArray(entry) ? /** @type {unknown[]} */ (entry)[0] : entry;
  if (level === 'error') return ERROR;
  if (level === 'warn') return 1;
  if (level === 'off' || level === undefined) return OFF;
  return Number(level);
}

/**
 * The computed rule severities for a repository path (the file need not exist).
 * @param {string} rel
 * @returns {Promise<Record<string, number>>}
 */
async function severities(rel) {
  const computed = asObject(await eslint.calculateConfigForFile(path.join(REPO_ROOT, rel)), rel);
  const rules = asObject(computed.rules, `${rel} rules`);
  return Object.fromEntries(
    Object.entries(rules).map(([name, entry]) => [name, severityOf(entry)]),
  );
}

/**
 * Lints one failing fixture and returns its messages.
 * @param {string} name  file name under scripts/fixtures/eslint/
 */
async function lintFixture(name) {
  const [result] = await unignored.lintFiles([path.join(FIXTURES, name)]);
  assert.ok(result, `no lint result for ${name}`);
  return result;
}

/**
 * Rule ids reported for a lint result, de-duplicated and sorted.
 * @param {import('eslint').ESLint.LintResult} result
 * @returns {string[]}
 */
function ruleIds(result) {
  return [...new Set(result.messages.map((m) => m.ruleId ?? '<fatal>'))].sort();
}

describe('ESLint flat config: structure', () => {
  it('ends with eslint-config-prettier so formatting rules can never fight Prettier', () => {
    const last = config.at(-1);
    assert.equal(last?.name, 'eslint-config-prettier');
  });

  it('leaves every rule eslint-config-prettier disables switched off, for code and tests', async () => {
    const disabled = Object.entries(prettierRules.rules)
      .filter(([, entry]) => severityOf(entry) === OFF)
      .map(([name]) => name);
    assert.ok(disabled.length > 0);
    for (const rel of ['packages/logger/src/index.ts', 'packages/logger/src/index.test.ts']) {
      const rules = await severities(rel);
      const fighting = disabled.filter((name) => (rules[name] ?? OFF) !== OFF);
      assert.deepEqual(
        fighting,
        [],
        `${rel}: formatting rules enabled after eslint-config-prettier`,
      );
    }
  });

  it('turns on type-aware linting through the project service (no per-tsconfig list)', async () => {
    const computed = asObject(
      await eslint.calculateConfigForFile(path.join(REPO_ROOT, 'packages/logger/src/index.ts')),
    );
    const parserOptions = asObject(asObject(computed.languageOptions).parserOptions);
    assert.ok(parserOptions.projectService, 'parserOptions.projectService must be enabled');
    assert.equal(parserOptions.project, undefined, 'use projectService instead of project');
    assert.equal(parserOptions.tsconfigRootDir, REPO_ROOT);
  });

  it('makes the no-any rule set and the promise/type-import rules hard errors in product code', async () => {
    const rules = await severities('apps/api/src/index.ts');
    for (const name of [
      '@typescript-eslint/no-explicit-any',
      '@typescript-eslint/no-non-null-assertion',
      '@typescript-eslint/no-unsafe-argument',
      '@typescript-eslint/no-unsafe-assignment',
      '@typescript-eslint/no-unsafe-call',
      '@typescript-eslint/no-unsafe-member-access',
      '@typescript-eslint/no-unsafe-return',
      '@typescript-eslint/no-floating-promises',
      '@typescript-eslint/no-misused-promises',
      '@typescript-eslint/require-await',
      '@typescript-eslint/consistent-type-imports',
      '@typescript-eslint/no-magic-numbers',
      'no-console',
      'no-eval',
      'no-new-func',
      '@typescript-eslint/no-implied-eval',
      'import/order',
      'import/no-default-export',
      'unicorn/prefer-node-protocol',
    ]) {
      assert.equal(rules[name], ERROR, `${name} must be "error"`);
    }
  });

  it('relaxes no-magic-numbers in test files only', async () => {
    assert.equal(
      (await severities('packages/ids/src/uuid.test.ts'))['@typescript-eslint/no-magic-numbers'],
      OFF,
    );
    assert.equal(
      (await severities('packages/ids/src/uuid.spec.ts'))['@typescript-eslint/no-magic-numbers'],
      OFF,
    );
    assert.equal(
      (await severities('packages/ids/src/uuid.ts'))['@typescript-eslint/no-magic-numbers'],
      ERROR,
    );
  });

  it('allows a default export in *.config.* files and Next.js route files only', async () => {
    for (const rel of [
      'apps/web/next.config.ts',
      'packages/ids/vitest.config.ts',
      'apps/web/playwright.config.mjs',
      'apps/web/src/app/page.tsx',
      'apps/web/src/app/runs/[runId]/layout.tsx',
    ]) {
      assert.equal((await severities(rel))['import/no-default-export'], OFF, rel);
    }
    for (const rel of ['packages/ids/src/uuid.ts', 'apps/web/src/components/page.tsx']) {
      assert.equal((await severities(rel))['import/no-default-export'], ERROR, rel);
    }
  });

  it('forbids console output except in apps/cli and scripts/', async () => {
    assert.equal((await severities('apps/cli/src/index.ts'))['no-console'], OFF);
    assert.equal((await severities('scripts/check-layout.mjs'))['no-console'], OFF);
    for (const rel of [
      'apps/api/src/index.ts',
      'apps/agent-runtime/src/index.ts',
      'packages/logger/src/index.ts',
      'packages/config/src/index.test.ts',
    ]) {
      assert.equal((await severities(rel))['no-console'], ERROR, rel);
    }
  });

  it('fails skipped, focused and todo tests in Vitest files, but not in node:test scripts', async () => {
    const vitest = await severities('packages/ids/src/uuid.test.ts');
    for (const name of [
      'vitest/no-disabled-tests',
      'vitest/no-focused-tests',
      'vitest/warn-todo',
    ]) {
      assert.equal(vitest[name], ERROR, name);
    }
    assert.equal(
      (await severities('scripts/check-layout.test.mjs'))['vitest/no-disabled-tests'],
      undefined,
    );
  });
});

describe('ESLint ignores generated code and build output', () => {
  for (const rel of [
    'packages/contracts/src/generated/openapi.ts',
    'apps/web/src/__generated__/graphql.ts',
    'packages/db/src/schema.generated.ts',
    'packages/contracts/src/client.gen.ts',
    'packages/ids/dist/index.js',
    'apps/web/.next/server/page.js',
    'node_modules/eslint/lib/api.js',
    'design/support.js',
  ]) {
    it(`ignores ${rel}`, async () => {
      assert.equal(await eslint.isPathIgnored(path.join(REPO_ROOT, rel)), true);
    });
  }

  it('still lints hand-written sources', async () => {
    for (const rel of [
      'packages/contracts/src/index.ts',
      'scripts/check-layout.mjs',
      'eslint.config.mjs',
    ]) {
      assert.equal(await eslint.isPathIgnored(path.join(REPO_ROOT, rel)), false, rel);
    }
  });

  it('keeps generated-code patterns in sync with .prettierignore', () => {
    const prettierIgnore = readFileSync(PRETTIER_IGNORE, 'utf8');
    for (const pattern of IGNORES.filter((p) => /generated|\.gen\./.test(p))) {
      const expected = pattern.replace(/^\*\*\//, '').replace(/\/\*\*$/, '/');
      assert.ok(
        prettierIgnore.includes(expected),
        `.prettierignore is missing the generated-code pattern "${expected}" (from ${pattern})`,
      );
    }
  });
});

describe('lint-fail fixtures (scripts/fixtures/eslint)', () => {
  it('the clean fixture produces no messages (the fixture project resolves and rules do not misfire)', async () => {
    const result = await lintFixture('clean.ts');
    assert.deepEqual(result.messages, []);
  });

  it('`any` fails lint', async () => {
    const result = await lintFixture('explicit-any.ts');
    assert.deepEqual(ruleIds(result), ['@typescript-eslint/no-explicit-any']);
    assert.equal(result.errorCount, 1);
  });

  it('a non-null assertion (`foo!`) fails lint', async () => {
    const result = await lintFixture('non-null-assertion.ts');
    assert.deepEqual(ruleIds(result), ['@typescript-eslint/no-non-null-assertion']);
  });

  it('a floating promise and an async function without await fail lint (type-aware rules fire)', async () => {
    const result = await lintFixture('floating-promise.ts');
    assert.deepEqual(ruleIds(result), [
      '@typescript-eslint/no-floating-promises',
      '@typescript-eslint/require-await',
    ]);
  });

  it('an implicit any leaking from JSON.parse fails lint (no-unsafe-*)', async () => {
    const result = await lintFixture('unsafe-any.ts');
    assert.deepEqual(ruleIds(result), [
      '@typescript-eslint/no-unsafe-assignment',
      '@typescript-eslint/no-unsafe-call',
      '@typescript-eslint/no-unsafe-member-access',
      '@typescript-eslint/no-unsafe-return',
    ]);
  });

  it('eval, the Function constructor and string timers fail lint', async () => {
    const result = await lintFixture('dynamic-code.ts');
    assert.deepEqual(ruleIds(result), [
      '@typescript-eslint/no-implied-eval',
      'no-eval',
      'no-new-func',
    ]);
  });

  it('skipped, focused and todo Vitest tests fail lint', async () => {
    const ids = ruleIds(await lintFixture('skipped.test.ts'));
    for (const name of [
      'vitest/no-disabled-tests',
      'vitest/no-focused-tests',
      'vitest/warn-todo',
    ]) {
      assert.ok(ids.includes(name), `${name} not reported; got ${ids.join(', ')}`);
    }
  });

  it('a file outside every tsconfig is a lint error, never linted without types', async () => {
    const result = await lintFixture('outside-tsconfig/orphan.ts');
    assert.equal(result.fatalErrorCount, 1);
    assert.match(result.messages[0]?.message ?? '', /was not found by the project service/);
  });

  it('every failing fixture is reported with error severity, so --max-warnings=0 is not needed to fail', async () => {
    const results = await unignored.lintFiles([FIXTURES]);
    const failing = results.filter((r) => !r.filePath.endsWith(`${path.sep}clean.ts`));
    assert.equal(
      failing.length,
      readdirSync(FIXTURES, { recursive: true }).filter((f) => String(f).endsWith('.ts')).length -
        1,
    );
    for (const result of failing) {
      assert.ok(result.errorCount > 0, `${result.filePath} has no errors`);
      assert.equal(result.warningCount, 0, `${result.filePath} has warnings`);
    }
  });

  it('product code that writes to the console fails lint; apps/cli may', async () => {
    const code = "export const name = 'x';\nconsole.log(name);\n";
    const [product] = await eslint.lintText(code, {
      filePath: path.join(REPO_ROOT, 'packages/logger/src/index.ts'),
    });
    assert.ok(product?.messages.some((m) => m.ruleId === 'no-console'));
    const [cli] = await eslint.lintText(code, {
      filePath: path.join(REPO_ROOT, 'apps/cli/src/index.ts'),
    });
    assert.deepEqual(
      cli?.messages.filter((m) => m.ruleId === 'no-console'),
      [],
    );
  });

  it('emits machine-readable JSON (eslint --format json) that CI can turn into annotations', async () => {
    const results = await unignored.lintFiles([path.join(FIXTURES, 'explicit-any.ts')]);
    const formatter = await unignored.loadFormatter('json');
    const parsed = /** @type {unknown} */ (JSON.parse(await formatter.format(results)));
    const [entry] = asArray(parsed, 'JSON report');
    const report = asObject(entry, 'report entry');
    assert.equal(report.filePath, path.join(FIXTURES, 'explicit-any.ts'));
    const [message] = asArray(report.messages, 'messages');
    const m = asObject(message, 'message');
    assert.equal(m.ruleId, '@typescript-eslint/no-explicit-any');
    assert.equal(m.severity, ERROR);
    assert.equal(typeof m.line, 'number');
    assert.equal(typeof m.column, 'number');
  });
});

describe('workflow determinism (apps/worker/src/workflows, WORKFLOW-003)', () => {
  // The snippets are linted as the content of real files (the project service needs the path to
  // exist in apps/worker's tsconfig); nothing is written to disk.
  const WORKFLOW = path.join(REPO_ROOT, 'apps/worker/src/workflows/kill-propagation.ts');
  const ACTIVITY = path.join(REPO_ROOT, 'apps/worker/src/kill/activities.ts');

  /**
   * Lints a snippet as if it lived at `filePath`.
   * @param {string} filePath
   * @param {string} code
   */
  async function lintAt(filePath, code) {
    const [result] = await eslint.lintText(code, { filePath });
    assert.ok(result, `no lint result for ${filePath}`);
    return result;
  }

  /**
   * Snippets that read the wall clock (Date.now(), new Date() with no argument, Date()).
   * They fail in workflows and pass in activities.
   */
  const CLOCK_SNIPPETS = {
    'Date.now()': 'export const at = Date.now();\n',
    'new Date()': 'export const at = new Date();\n',
    'Date()': 'export const at = Date();\n',
  };

  for (const [name, code] of Object.entries(CLOCK_SNIPPETS)) {
    it(`fails lint for ${name} in a workflow file`, async () => {
      const ids = ruleIds(await lintAt(WORKFLOW, code));
      assert.ok(ids.includes('no-restricted-syntax'), `got ${ids.join(', ')}`);
    });

    it(`passes lint for ${name} in an activity file`, async () => {
      const ids = ruleIds(await lintAt(ACTIVITY, code));
      assert.ok(!ids.includes('no-restricted-syntax'), `got ${ids.join(', ')}`);
    });
  }

  it('allows deterministic time and randomness through the SDK', async () => {
    const code = [
      "import { sleep, uuid4, workflowInfo } from '@temporalio/workflow';",
      '',
      'export async function step(): Promise<string> {',
      '  await sleep(1);',
      '  return `${String(workflowInfo().startTime.getTime())}-${uuid4()}`;',
      '}',
      '',
      'export const epoch = new Date(0);',
      '',
    ].join('\n');
    assert.deepEqual(ruleIds(await lintAt(WORKFLOW, code)), []);
  });

  const BANNED_SNIPPETS = [
    {
      name: 'Math.random()',
      rule: 'no-restricted-properties',
      code: 'export const roll = Math.random();\n',
    },
    {
      name: 'setTimeout',
      rule: 'no-restricted-globals',
      code: 'export const timer = setTimeout(() => undefined, 1);\n',
    },
    {
      name: 'setInterval',
      rule: 'no-restricted-globals',
      code: 'export const timer = setInterval(() => undefined, 1);\n',
    },
    {
      name: 'process.env',
      rule: 'no-restricted-globals',
      code: 'export const port = process.env.PORT;\n',
    },
    {
      name: 'the global crypto object',
      rule: 'no-restricted-globals',
      code: 'export const id = crypto.randomUUID();\n',
    },
    {
      name: 'fetch',
      rule: 'no-restricted-globals',
      code: "export const response = fetch('https://example.invalid');\n",
    },
    {
      name: 'a node:crypto import',
      rule: 'no-restricted-imports',
      code: "import { randomUUID } from 'node:crypto';\nexport const id = randomUUID();\n",
    },
    {
      name: 'a bare crypto import',
      rule: 'no-restricted-imports',
      code: "import { randomUUID } from 'crypto';\nexport const id = randomUUID();\n",
    },
    {
      name: 'a node:fs import',
      rule: 'no-restricted-imports',
      code: "import { readFileSync } from 'node:fs';\nexport const text = readFileSync('x', 'utf8');\n",
    },
    {
      name: 'an ioredis value import',
      rule: 'no-restricted-imports',
      code: "import { Redis } from 'ioredis';\nexport const client = Redis;\n",
    },
    {
      name: 'a pg value import',
      rule: 'no-restricted-imports',
      code: "import { Pool } from 'pg';\nexport const pool = Pool;\n",
    },
    {
      name: 'a @temporalio/client value import',
      rule: 'no-restricted-imports',
      code: "import { Client } from '@temporalio/client';\nexport const client = Client;\n",
    },
  ];

  for (const { name, rule, code } of BANNED_SNIPPETS) {
    it(`fails lint for ${name} in a workflow file`, async () => {
      assert.ok(ruleIds(await lintAt(WORKFLOW, code)).includes(rule), `${rule} not reported`);
    });
  }

  it('passes lint for the same banned APIs in an activity file', async () => {
    for (const { name, code } of BANNED_SNIPPETS) {
      assert.deepEqual(
        ruleIds(await lintAt(ACTIVITY, code)).filter((id) => id.startsWith('no-restricted')),
        [],
        `${name} must stay allowed in activities`,
      );
    }
  });

  it('allows type-only imports of banned modules (import type is the escape hatch)', async () => {
    const code = [
      "import type { Redis } from 'ioredis';",
      "import type { Client } from '@temporalio/client';",
      "import type { Stats } from 'node:fs';",
      'export type Handles = { redis: Redis; client: Client; stats: Stats };',
      '',
    ].join('\n');
    const ids = ruleIds(await lintAt(WORKFLOW, code));
    assert.ok(!ids.includes('no-restricted-imports'), `got ${ids.join(', ')}`);
  });
});

describe('Prettier', () => {
  const SAMPLE = `import {b,a} from "./x.js"
export const longName = { first: "alpha", second: "beta", third: "gamma", fourth: "delta", fifth: 5 }
export function f(x: number) { return x+1 }
`;

  it('uses the agreed options for every file', async () => {
    const options = await prettier.resolveConfig(path.join(REPO_ROOT, 'packages/ids/src/uuid.ts'));
    assert.deepEqual(options, {
      printWidth: 100,
      singleQuote: true,
      semi: true,
      trailingComma: 'all',
    });
  });

  it('formats idempotently: formatting formatted code changes nothing', async () => {
    const filepath = path.join(REPO_ROOT, 'packages/ids/src/sample.ts');
    const options = { ...(await prettier.resolveConfig(filepath)), filepath };
    const once = await prettier.format(SAMPLE, options);
    assert.notEqual(once, SAMPLE);
    assert.equal(await prettier.format(once, options), once);
    assert.equal(await prettier.check(once, options), true);
    assert.match(once, /'alpha'/);
    assert.match(once, /fifth: 5,\n/);
  });

  for (const rel of [
    'packages/contracts/src/generated/openapi.ts',
    'apps/web/src/__generated__/graphql.ts',
    'packages/db/src/schema.generated.ts',
    'packages/contracts/src/client.gen.ts',
    'pnpm-lock.yaml',
    'scripts/fixtures/eslint/explicit-any.ts',
    'design/tokens.json',
  ]) {
    it(`ignores ${rel}`, async () => {
      const info = await prettier.getFileInfo(path.join(REPO_ROOT, rel), {
        ignorePath: PRETTIER_IGNORE,
      });
      assert.equal(info.ignored, true);
    });
  }

  it('formats hand-written TypeScript, scripts, JSON and YAML', async () => {
    for (const rel of [
      'packages/ids/src/uuid.ts',
      'scripts/check-layout.mjs',
      'turbo.json',
      'pnpm-workspace.yaml',
    ]) {
      const info = await prettier.getFileInfo(path.join(REPO_ROOT, rel), {
        ignorePath: PRETTIER_IGNORE,
      });
      assert.equal(info.ignored, false, rel);
    }
  });
});

describe('lint and format scripts', () => {
  const root = readJsonObject(path.join(REPO_ROOT, 'package.json'));
  const scripts = asObject(root.scripts, 'package.json scripts');

  it('the root exposes lint (Turborepo), format, format:check and a JSON lint report', () => {
    assert.equal(scripts.lint, 'turbo run lint');
    assert.equal(scripts.format, 'prettier --write .');
    assert.equal(scripts['format:check'], 'prettier --check .');
    assert.match(String(scripts['lint:report']), /eslint \. --max-warnings=0 --format json/);
    assert.match(String(scripts['lint:root']), /eslint \. --max-warnings=0/);
  });

  it('every workspace member lints itself with zero warnings allowed', () => {
    for (const kind of ['apps', 'packages']) {
      for (const dir of readdirSync(path.join(REPO_ROOT, kind))) {
        const file = path.join(REPO_ROOT, kind, dir, 'package.json');
        const manifest = parseJsonObject(readFileSync(file, 'utf8'), file);
        const memberScripts = asObject(manifest.scripts, `${kind}/${dir} scripts`);
        assert.equal(memberScripts.lint, 'eslint . --max-warnings=0', `${kind}/${dir}`);
      }
    }
  });
});
