// Tests for the blackwing/no-raw-tenant-db rule (TENANT-002). The fixtures under
// scripts/fixtures/tenant-db/ are type-checked TypeScript with a minimal drizzle stand-in; they are
// excluded from normal lint runs and linted explicitly here with only this rule switched on.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

import { REPO_ROOT } from '../test-fixtures.mjs';
import { blackwingPlugin } from './index.mjs';

const FIXTURES = path.join(REPO_ROOT, 'scripts', 'fixtures', 'tenant-db');

const eslint = new ESLint({
  cwd: REPO_ROOT,
  ignore: false,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { project: path.join(FIXTURES, 'tsconfig.json'), tsconfigRootDir: FIXTURES },
      },
      plugins: { blackwing: blackwingPlugin },
      rules: { 'blackwing/no-raw-tenant-db': 'error' },
    },
  ],
});

/**
 * Lints one fixture and returns the reported (function line, table) pairs.
 * @param {string} name
 */
async function lint(name) {
  const [result] = await eslint.lintFiles([path.join(FIXTURES, name)]);
  assert.ok(result, `no lint result for ${name}`);
  assert.deepEqual(
    result.messages.filter((m) => m.ruleId !== 'blackwing/no-raw-tenant-db'),
    [],
    `${name}: unexpected non-rule messages (parse errors?)`,
  );
  return result.messages;
}

describe('blackwing/no-raw-tenant-db', () => {
  it('reports every raw-handle query against a tenant-scoped table', async () => {
    const messages = await lint('violations.ts');
    assert.deepEqual(
      messages.map((m) => m.line),
      [6, 10, 14, 18, 22, 26, 26, 30, 34, 38, 44, 49],
    );
    assert.ok(messages.every((m) => m.messageId === 'rawTenantDb'));
  });

  it('names the table and points at withTenant', async () => {
    const [first] = await lint('violations.ts');
    assert.ok(first);
    assert.match(first.message, /"widgets"/);
    assert.match(first.message, /withTenant/);
  });

  it('flags each tenant table of a join, and a join reached through a non-identifier from()', async () => {
    const messages = await lint('violations.ts');
    assert.deepEqual(
      messages
        .filter((m) => m.line === 26)
        .map((m) => /"(\w+)"/.exec(m.message)?.[1])
        .sort(),
      ['gadgets', 'widgets'],
    );
    assert.match(messages.find((m) => m.line === 30)?.message ?? '', /"widgets"/);
  });

  it('passes the same queries inside withTenant, on a TenantTx, on a SystemTx, on global tables and when annotated', async () => {
    assert.deepEqual(await lint('allowed.ts'), []);
  });

  it('does not accept an allow annotation without a reason', async () => {
    const messages = await lint('annotation-without-reason.ts');
    assert.equal(messages.length, 1);
  });
});
