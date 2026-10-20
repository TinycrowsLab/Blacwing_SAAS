// Tests for check-env (DEVENV-003, #157) and the .env.example contract.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { diffEnv, main, parseEnv } from './check-env.mjs';
import { renderEnv } from './dev-deps.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const PW = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const RENDERED = renderEnv(example, '', () => PW).text;
const quiet = { out: () => undefined, err: () => undefined };

/** @param {string} text @param {(envFile: string) => void} fn */
function withEnvFile(text, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bw-env-'));
  try {
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, text);
    fn(envFile);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-env', () => {
  it('parses comments, CRLF and quotes', () => {
    const m = parseEnv('# c\r\nA=1\r\nexport B="two"\r\n  # C=3\r\nD=\r\n');
    assert.deepEqual(
      [...m],
      [
        ['A', '1'],
        ['B', 'two'],
        ['D', ''],
      ],
    );
  });

  it('flags a missing required key and an empty one', () => {
    const d = diffEnv('A=1\nB=2\nC=3\n', 'A=1\nC=\nX=9\n');
    assert.deepEqual(d, { missing: ['B'], empty: ['C'], extra: ['X'] });
  });

  it('exits 1 naming a missing key, never printing values', () => {
    withEnvFile(RENDERED.replace(/^DATABASE_URL=.*\n/m, ''), (envFile) => {
      let err = '';
      const code = main(['--env', envFile], { out: () => undefined, err: (s) => (err += s) });
      assert.equal(code, 1);
      assert.match(err, /missing keys: DATABASE_URL/);
      assert.ok(!err.includes(PW));
    });
  });

  it('passes for an env rendered from the example; exits 2 without .env', () => {
    withEnvFile(RENDERED, (envFile) => {
      assert.equal(main(['--env', envFile], quiet), 0);
      assert.equal(main(['--env', `${envFile}.nope`], quiet), 2);
    });
  });
});

describe('.env.example', () => {
  const vars = parseEnv(example);

  it('covers the required service keys', () => {
    for (const k of [
      'NODE_ENV',
      'LOG_LEVEL',
      'DATABASE_URL',
      'VALKEY_URL',
      'NEO4J_URI',
      'TEMPORAL_ADDRESS',
      'KEYCLOAK_ISSUER_URL',
      'OPENBAO_ADDR',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'SMTP_URL',
      'INTERACTSH_URL',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ]) {
      assert.ok(vars.has(k), `missing ${k}`);
    }
  });

  it('holds no real secret: secret-shaped keys are empty, change-me-dev or a ${REF}', () => {
    for (const [k, v] of vars) {
      if (!/(PASSWORD|SECRET|TOKEN)/.test(k) || k.endsWith('_ENABLED')) continue;
      assert.ok(
        v === '' || v === 'change-me-dev' || /^\$\{[A-Z0-9_]+\}$/.test(v),
        `${k} looks real`,
      );
    }
  });

  it('renders with every reference resolved, passwords embedded in URLs', () => {
    assert.ok(!RENDERED.includes('${'), 'unresolved reference');
    assert.match(RENDERED, new RegExp(`^DATABASE_URL=postgres://bw_app:${PW}@`, 'm'));
  });

  it('documents the dev-only toggle', () => {
    assert.match(example, /\[DEV-ONLY\] toggles[\s\S]*BW_DEV_PASSWORD_LOGIN_ENABLED/);
  });

  it('is LF only; .env is ignored and .env.example tracked', () => {
    assert.ok(!example.includes('\r'));
    /** @param {string} f */
    const ignored = (f) => {
      try {
        execFileSync('git', ['check-ignore', '-q', f], { cwd: ROOT });
        return true;
      } catch {
        return false;
      }
    };
    assert.ok(ignored('.env'));
    assert.ok(ignored('.env.local'));
    assert.ok(!ignored('.env.example'));
  });

  it('edge case: Windows line endings in .env still parse', () => {
    assert.equal(parseEnv(RENDERED.replace(/\n/g, '\r\n')).get('NODE_ENV'), 'development');
  });
});
