import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  ENDPOINT_PORTS,
  ONBOARDING,
  REALM_EXPORT,
  checkOnboarding,
  parseDotenv,
  pnpmCommands,
} from './check-onboarding.mjs';
import { REPO_ROOT, SCRIPTS_DIR, cleanEnv } from './test-fixtures.mjs';

/** @type {string[]} */
const tempRoots = [];

const REALM = JSON.stringify({
  users: [{ username: 'a@acme.test' }, { username: 'service-account-bw-ci' }],
  clients: [{ clientId: 'bw-console-bff', redirectUris: ['http://localhost:3000/auth/callback'] }],
});
const ENV = ENDPOINT_PORTS.map(([key], i) => `${key ?? ''}=${String(20000 + i)}`).join('\n');
const GOOD_GUIDE = [
  '# Guide',
  '## Section',
  'See [self](#section) and [other](other.md#target).',
  '```bash',
  'pnpm dev',
  '```',
  '`a@acme.test` and `http://localhost:3000`',
  ...ENDPOINT_PORTS.map(([, tpl], i) => `\`${(tpl ?? '').replace('{p}', String(20000 + i))}\``),
].join('\n');

/**
 * @param {Record<string, string>} overrides file content by relative path
 * @returns {string}
 */
function makeRoot(overrides = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-onboarding-'));
  tempRoots.push(root);
  /** @type {Record<string, string>} */
  const files = {
    'package.json': JSON.stringify({ scripts: { dev: 'x' } }),
    '.env.example': ENV,
    [REALM_EXPORT]: REALM,
    [ONBOARDING]: GOOD_GUIDE,
    'docs/user/other.md': '# Other\n## Target\n',
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * @param {string[]} errors
 * @param {RegExp} pattern
 */
function assertError(errors, pattern) {
  assert.ok(
    errors.some((e) => pattern.test(e)),
    `expected an error matching ${pattern}, got:\n${errors.join('\n') || '(none)'}`,
  );
}

describe('check-onboarding helpers', () => {
  it('extracts pnpm script names from fences and inline code', () => {
    assert.deepEqual(pnpmCommands('```\npnpm dev:deps\n```\nand `pnpm test:e2e`'), [
      'dev:deps',
      'test:e2e',
    ]);
  });

  it('parses dotenv keys and ignores comments', () => {
    assert.deepEqual(
      [...parseDotenv('# c\nA=1\nB=\n')],
      [
        ['A', '1'],
        ['B', ''],
      ],
    );
  });
});

describe('checkOnboarding', () => {
  it('accepts a consistent guide', () => {
    const result = checkOnboarding(makeRoot());
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it('passes on the real repository', () => {
    const result = checkOnboarding(REPO_ROOT);
    assert.deepEqual(result.errors, []);
  });

  it('flags a missing guide', () => {
    const root = makeRoot();
    rmSync(path.join(root, ONBOARDING));
    assertError(checkOnboarding(root).errors, /onboarding\.md: missing/);
  });

  it('flags a broken file link and a missing anchor', () => {
    const root = makeRoot({
      [ONBOARDING]: `${GOOD_GUIDE}\n[a](gone.md) [b](other.md#nope) [c](#nope)`,
    });
    const errors = checkOnboarding(root).errors;
    assertError(errors, /broken link gone\.md/);
    assertError(errors, /other\.md#nope matches no heading/);
    assertError(errors, /#nope matches no heading/);
  });

  it('flags a pnpm command that is not a package script', () => {
    const root = makeRoot({ [ONBOARDING]: `${GOOD_GUIDE}\n\`pnpm nonexistent:thing\`` });
    assertError(checkOnboarding(root).errors, /pnpm nonexistent:thing/);
  });

  it('allows pnpm built-ins', () => {
    const root = makeRoot({ [ONBOARDING]: `${GOOD_GUIDE}\n\`pnpm install\`` });
    assert.equal(checkOnboarding(root).ok, true);
  });

  it('flags an undocumented realm user and an unknown user', () => {
    const realm = JSON.stringify({
      users: [{ username: 'a@acme.test' }, { username: 'b@acme.test' }],
      clients: [],
    });
    assertError(
      checkOnboarding(makeRoot({ [REALM_EXPORT]: realm })).errors,
      /b@acme\.test is not documented/,
    );
    const root = makeRoot({ [ONBOARDING]: `${GOOD_GUIDE}\n\`ghost@acme.test\`` });
    assertError(checkOnboarding(root).errors, /ghost@acme\.test is not a user/);
  });

  it('flags a redirect origin the guide does not mention', () => {
    const realm = JSON.stringify({
      users: [{ username: 'a@acme.test' }],
      clients: [
        { clientId: 'bw-console-bff', redirectUris: ['https://new.example.test/auth/callback'] },
      ],
    });
    assertError(checkOnboarding(makeRoot({ [REALM_EXPORT]: realm })).errors, /new\.example\.test/);
  });

  it('flags a port that drifted from .env.example', () => {
    const root = makeRoot({ '.env.example': ENV.replace('=20000', '=29999') });
    assertError(checkOnboarding(root).errors, /BW_DEV_KEYCLOAK_PORT=29999/);
  });

  it('flags a key without a default port', () => {
    const root = makeRoot({ '.env.example': ENV.replace('=20000', '=') });
    assertError(checkOnboarding(root).errors, /BW_DEV_KEYCLOAK_PORT has no default/);
  });
});

describe('check-onboarding CLI', () => {
  it('exits 0 on the real repository and 1 on a broken root', () => {
    const run = (/** @type {string[]} */ args) =>
      spawnSync(process.execPath, [path.join(SCRIPTS_DIR, 'check-onboarding.mjs'), ...args], {
        encoding: 'utf8',
        env: cleanEnv(),
      });
    assert.equal(run(['--quiet']).status, 0);
    const root = makeRoot({ [ONBOARDING]: `${GOOD_GUIDE}\n[a](gone.md)` });
    const bad = run(['--quiet', '--root', root]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /broken link/);
    assert.equal(run(['--bogus']).status, 2);
  });

  it('is wired as a root script', () => {
    /** @type {{ scripts: Record<string, string> }} */
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')); // eslint-disable-line @typescript-eslint/no-unsafe-assignment
    assert.equal(pkg.scripts['check:onboarding'], 'node scripts/check-onboarding.mjs');
  });
});
