// Tests for the bw-sandbox Dockerfile guard (IMAGE-001, #599).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SANDBOX_DOCKERFILE,
  SANDBOX_DOCKERIGNORE,
  checkRepo,
  checkSandboxDockerfile,
} from './check-sandbox-image.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const df = readFileSync(path.join(REPO_ROOT, SANDBOX_DOCKERFILE), 'utf8');
const ig = readFileSync(path.join(REPO_ROOT, SANDBOX_DOCKERIGNORE), 'utf8');
/** @param {string} d @param {string} [i] */
const errs = (d, i = ig) => checkSandboxDockerfile(d, i);

describe('real repository', () => {
  it('passes the guard', () => {
    assert.deepEqual(checkRepo(REPO_ROOT), []);
  });
});

describe('checkSandboxDockerfile', () => {
  it('rejects a floating or digest-less base image', () => {
    const bad = df.replace(/@sha256:[0-9a-f]{64}/, '');
    assert.ok(errs(bad).some((e) => e.includes('digest')));
    assert.ok(errs(df.replace(/@sha256:[0-9a-f]{64}/, ':latest')).length > 0);
  });

  it('rejects running as root (USER removed or final USER root)', () => {
    assert.ok(errs(df.replace(/^USER bw:bw$/m, 'USER root')).some((e) => e.includes('final USER')));
    assert.ok(errs(df.replace(/^USER bw:bw$/m, '')).some((e) => e.includes('USER')));
  });

  it('rejects a user appended after USER bw', () => {
    assert.ok(errs(`${df}\nUSER root\n`).some((e) => e.includes('final USER')));
  });

  it('requires uid/gid 10001', () => {
    assert.ok(errs(df.replaceAll('10001', '1000')).some((e) => e.includes('10001')));
  });

  it('requires the standard directories, env defaults and healthcheck', () => {
    assert.ok(errs(df.replaceAll('/opt/bw/wordlists', '/x')).some((e) => e.includes('wordlists')));
    assert.ok(errs(df.replace('BW_SANDBOX=1', 'BW_X=1')).some((e) => e.includes('BW_SANDBOX')));
    assert.ok(
      errs(df.replace(/^HEALTHCHECK /m, '# HEALTHCHECK ')).some((e) => e.includes('HEALTHCHECK')),
    );
  });

  it('rejects secrets in ENV', () => {
    assert.ok(
      errs(df.replace('BW_SANDBOX=1', 'BW_SANDBOX=1 ANTHROPIC_API_KEY=x')).some((e) =>
        e.includes('secrets'),
      ),
    );
  });

  it('requires an allow-list dockerignore', () => {
    assert.ok(errs(df, '.git\n').some((e) => e.includes('dockerignore')));
  });
});
