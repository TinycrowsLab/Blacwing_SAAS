import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { checkNodeVersion, checkPackageManager, runPreinstallChecks } from './preinstall.mjs';
import { cleanEnv, makeValidFixture, writeMember } from './test-fixtures.mjs';

const PNPM_UA = 'pnpm/9.15.0 npm/? node/v22.22.1 linux x64';

describe('checkPackageManager (only-allow pnpm)', () => {
  it('allows pnpm', () => {
    assert.equal(checkPackageManager(PNPM_UA), null);
  });

  it('allows runs that were not started by a package manager', () => {
    assert.equal(checkPackageManager(undefined), null);
    assert.equal(checkPackageManager(''), null);
  });

  for (const ua of [
    'npm/10.9.2 node/v22.22.1 linux x64 workspaces/false',
    'yarn/1.22.22 npm/? node/v22.22.1 linux x64',
    'bun/1.1.38 npm/? node/v22.22.1 linux x64',
  ]) {
    it(`rejects ${ua.split(' ')[0]}`, () => {
      assert.match(checkPackageManager(ua) ?? '', /must be installed with pnpm/);
    });
  }
});

describe('checkNodeVersion', () => {
  for (const ok of ['v22.0.0', 'v22.22.1', '22.11.0']) {
    it(`accepts ${ok}`, () => {
      assert.equal(checkNodeVersion(ok), null);
    });
  }

  for (const bad of ['v20.18.0', 'v21.7.3', 'v23.0.0', 'v24.1.0', 'v18.20.4']) {
    it(`rejects ${bad}`, () => {
      assert.match(checkNodeVersion(bad) ?? '', /Node\.js 22 LTS is required/);
    });
  }

  it('rejects an unrecognised version string', () => {
    assert.match(checkNodeVersion('banana') ?? '', /Unrecognised Node\.js version/);
  });
});

describe('runPreinstallChecks', () => {
  /** @type {{ root: string, cleanup: () => void }} */
  let fixture;
  beforeEach(() => {
    fixture = makeValidFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  it('passes for pnpm on Node 22 with a valid layout', () => {
    assert.deepEqual(
      runPreinstallChecks({ userAgent: PNPM_UA, nodeVersion: 'v22.22.1', root: fixture.root }),
      [],
    );
  });

  it('reports every problem at once', () => {
    writeMember(fixture.root, 'packages/logger', { name: '@blackwing/config' });
    const problems = runPreinstallChecks({
      userAgent: 'npm/10.9.2 node/v20.18.0 linux x64',
      nodeVersion: 'v20.18.0',
      root: fixture.root,
    });
    assert.match(problems[0] ?? '', /must be installed with pnpm/);
    assert.match(problems[1] ?? '', /Node\.js 22 LTS is required/);
    const layout = problems.slice(2);
    assert.ok(
      layout.length > 0 && layout.every((p) => p.startsWith('layout: ')),
      problems.join('\n'),
    );
    assert.ok(
      layout.some((p) => p.startsWith('layout: duplicate package name "@blackwing/config"')),
      problems.join('\n'),
    );
  });

  it('exits non-zero when run under npm', () => {
    const script = path.join(fixture.root, 'scripts', 'preinstall.mjs');
    const run = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: cleanEnv({ npm_config_user_agent: 'npm/10.9.2 node/v22.22.1 linux x64' }),
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /refusing to install/);
    assert.match(run.stderr, /must be installed with pnpm/);
  });
});

describe('pnpm install guard (integration)', () => {
  /** @type {{ root: string, cleanup: () => void }} */
  let fixture;
  beforeEach(() => {
    fixture = makeValidFixture();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  /** @param {string} root */
  function pnpmInstall(root) {
    return spawnSync('pnpm', ['install', '--offline', '--reporter=append-only'], {
      cwd: root,
      encoding: 'utf8',
      env: cleanEnv({ COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', CI: 'true' }),
      timeout: 120_000,
    });
  }

  it('succeeds on a valid layout', () => {
    const run = pnpmInstall(fixture.root);
    assert.equal(run.error, undefined, String(run.error));
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  });

  it('fails loudly on a duplicate package name (pnpm alone would accept it)', () => {
    writeMember(fixture.root, 'packages/logger', { name: '@blackwing/config' });
    const run = pnpmInstall(fixture.root);
    assert.equal(run.error, undefined, String(run.error));
    assert.notEqual(run.status, 0);
    assert.match(`${run.stdout}\n${run.stderr}`, /duplicate package name "@blackwing\/config"/);
  });

  it('fails loudly on a member with a missing name', () => {
    writeMember(fixture.root, 'apps/api', { name: '' });
    const run = pnpmInstall(fixture.root);
    assert.notEqual(run.status, 0);
    assert.match(`${run.stdout}\n${run.stderr}`, /apps\/api\/package\.json: "name" is missing/);
  });
});
