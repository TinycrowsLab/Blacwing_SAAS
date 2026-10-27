// Fixture tests for the blackwing/no-literal-ui-strings rule (#272). Each snippet is linted as if it
// were a shell component, so the rule sees the same JSX it would see in apps/web.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ESLint } from 'eslint';

import { REPO_ROOT } from '../test-fixtures.mjs';
import { blackwingPlugin } from './index.mjs';

const SHELL_FILE = path.join(REPO_ROOT, 'apps', 'web', 'src', 'components', 'shell', 'fixture.tsx');

const eslint = new ESLint({
  cwd: REPO_ROOT,
  ignore: false,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.tsx'],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { blackwing: blackwingPlugin },
      rules: { 'blackwing/no-literal-ui-strings': 'error' },
    },
  ],
});

/** @param {string} code @returns {Promise<string[]>} rule messages for `code` */
async function messagesFor(code) {
  const [result] = await eslint.lintText(code, { filePath: SHELL_FILE });
  assert.ok(result, 'no lint result');
  assert.deepEqual(
    result.messages.filter((m) => m.fatal === true),
    [],
    'parse error in fixture',
  );
  return result.messages.map((m) => m.message);
}

describe('blackwing/no-literal-ui-strings', () => {
  it('flags bare JSX text', async () => {
    const messages = await messagesFor('export const A = () => <span>Open navigation</span>;\n');
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /Hard-coded UI string "Open navigation"/);
  });

  it('flags a string literal child expression', async () => {
    const messages = await messagesFor("export const A = () => <span>{'Runs'}</span>;\n");
    assert.equal(messages.length, 1);
  });

  it('flags literal values of accessible-name and text attributes', async () => {
    const messages = await messagesFor(
      [
        'export const A = () => (',
        '  <>',
        '    <button aria-label="Close">x</button>',
        "    <button aria-label={'Close'}>y</button>",
        '    <img alt="Logo" src="/logo.png" />',
        '    <input placeholder="Search" />',
        '    <span title="Hint">z</span>',
        '  </>',
        ');',
        '',
      ].join('\n'),
    );
    // The button text "x", "y" and "z" are literal text too: 3 text nodes + 5 attributes.
    assert.equal(messages.length, 8);
  });

  it('flags string literals on both branches of a conditional attribute value', async () => {
    const messages = await messagesFor(
      "export const A = ({ on }) => <button aria-label={on ? 'Open' : 'Close'} />;\n",
    );
    assert.equal(messages.length, 2);
  });

  it('flags a literal on a conditional child expression', async () => {
    const messages = await messagesFor(
      "export const A = ({ on }) => <span>{on ? 'Yes' : t('x')}</span>;\n",
    );
    assert.equal(messages.length, 1);
  });

  it('allows catalogue keys, expressions, decorative attributes and whitespace', async () => {
    const messages = await messagesFor(
      [
        "import { t } from '../../lib/i18n';",
        'export const A = ({ label }) => (',
        '  <nav aria-label={t("common.primaryNavigation")}>',
        '    <span aria-hidden="true" />',
        "    <span>{' '}</span>",
        '    <span>{label}</span>',
        '    <span title={label}>{t("nav.item.runs")}</span>',
        '  </nav>',
        ');',
        '',
      ].join('\n'),
    );
    assert.deepEqual(messages, []);
  });
});
