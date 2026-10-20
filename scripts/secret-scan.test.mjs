// Integration self-test for the gitleaks ruleset (CI-012, #146; CONTEXT_PACK §8.7). Runs the real
// gitleaks binary (GITLEAKS_BIN, else `gitleaks` on PATH) with the repository's .gitleaks.toml against
// throwaway git repositories: a planted fake Blackwing token fails, allowlisted fixtures pass, no
// output ever contains the secret value, PR/push scans are scoped to the diff, and the repository's
// own history is clean. Fake secrets are assembled at runtime so this file never matches a rule.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { countFindings } from './gitleaks-summary.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const GITLEAKS = process.env.GITLEAKS_BIN ?? 'gitleaks';
const CONFIG = path.join(REPO_ROOT, '.gitleaks.toml');
const ALLOWED_FIXTURE = 'scripts/fixtures/gitleaks/allowed/fake-credentials.txt';

/** A fake, never-issued token with a Blackwing prefix (`bw_pat`, `bw_ci`, `bwk`). */
const fakeToken = (/** @type {string} */ prefix) =>
  `${prefix}_${randomBytes(24).toString('base64url').replaceAll('-', 'x')}`;

/** A random literal that looks like a real password (base62, 24 chars). */
const fakePassword = () => randomBytes(18).toString('base64url').replaceAll(/[-_]/g, 'Q');

/**
 * @typedef {{ status: number | null, output: string, sarif: unknown, reportText: string }} ScanResult
 */

/** @type {string[]} */
const tempDirs = [];

/** A throwaway git repository with the shared .gitleaks.toml at its root. */
class TempRepo {
  constructor() {
    /** @type {string} */
    this.dir = mkdtempSync(path.join(tmpdir(), 'bw-gitleaks-'));
    tempDirs.push(this.dir);
    this.git(['init', '-q', '-b', 'main']);
    copyFileSync(CONFIG, path.join(this.dir, '.gitleaks.toml'));
    this.commit('chore: add gitleaks config');
  }

  /**
   * @param {string[]} args
   * @returns {string} trimmed stdout
   */
  git(args) {
    /** @type {import('node:child_process').SpawnSyncReturns<string>} */
    const result = spawnSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { cwd: this.dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** @param {string} file @param {string} contents */
  write(file, contents) {
    mkdirSync(path.dirname(path.join(this.dir, file)), { recursive: true });
    writeFileSync(path.join(this.dir, file), contents);
  }

  /** @param {string} message @returns {string} the new HEAD sha */
  commit(message) {
    this.git(['add', '-A']);
    this.git(['commit', '-q', '--allow-empty', '-m', message]);
    return this.git(['rev-parse', 'HEAD']);
  }

  /**
   * Runs gitleaks exactly as CI does (detect, --redact, the shared config, SARIF report).
   * @param {string[]} [extra] extra arguments, e.g. ['--log-opts', 'a..b']
   * @returns {ScanResult}
   */
  scan(extra = []) {
    return runGitleaks(this.dir, ['detect', '--source', this.dir, ...extra]);
  }
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {ScanResult}
 */
function runGitleaks(cwd, args) {
  const report = path.join(mkdtempSync(path.join(tmpdir(), 'bw-gitleaks-report-')), 'report.sarif');
  tempDirs.push(path.dirname(report));
  const result = spawnSync(
    GITLEAKS,
    [
      ...args,
      '--redact',
      '--no-banner',
      '--config',
      path.join(cwd, '.gitleaks.toml'),
      '--exit-code',
      '1',
      '--report-format',
      'sarif',
      '--report-path',
      report,
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, GITLEAKS_CONFIG: '' } },
  );
  assert.ok(
    result.error === undefined,
    `cannot run ${GITLEAKS}: install gitleaks or set GITLEAKS_BIN`,
  );
  const reportText = existsSync(report) ? readFileSync(report, 'utf8') : '';
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    sarif: reportText === '' ? { runs: [] } : JSON.parse(reportText),
    reportText,
  };
}

/** @param {ScanResult} result @returns {string[]} sorted rule ids */
const rulesOf = (result) => [...countFindings(result.sarif).byRule.keys()].sort();

/** @param {ScanResult} result @param {string} secret */
function assertNeverPrinted(result, secret) {
  assert.ok(!result.output.includes(secret), 'gitleaks stdout/stderr must not contain the secret');
  assert.ok(!result.reportText.includes(secret), 'the SARIF report must not contain the secret');
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('gitleaks ruleset (.gitleaks.toml)', () => {
  before(() => {
    const version = spawnSync(GITLEAKS, ['version'], { encoding: 'utf8' });
    assert.ok(
      version.status === 0,
      `gitleaks is required: install it or set GITLEAKS_BIN (${GITLEAKS})`,
    );
  });

  it('fails on a committed fake bw_pat_ token and redacts it everywhere', () => {
    const repo = new TempRepo();
    const token = fakeToken('bw_pat');
    repo.write('apps/api/src/client.ts', `export const auth = 'Bearer ${token}';\n`);
    repo.commit('feat(api): add client');
    const result = repo.scan();
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(rulesOf(result), ['blackwing-personal-access-token']);
    assertNeverPrinted(result, token);
    assert.match(result.reportText, /REDACTED/);
  });

  for (const [prefix, rule] of /** @type {Array<[string, string]>} */ ([
    ['bw_ci', 'blackwing-ci-token'],
    ['bwk', 'blackwing-virtual-model-key'],
  ])) {
    it(`fails on a committed fake ${prefix}_ token (${rule})`, () => {
      const repo = new TempRepo();
      const token = fakeToken(prefix);
      repo.write('deploy/pipeline.env', `TOKEN=${token}\n`);
      repo.commit('chore: add pipeline env');
      const result = repo.scan();
      assert.equal(result.status, 1, result.output);
      assert.ok(rulesOf(result).includes(rule), rulesOf(result).join(','));
      assertNeverPrinted(result, token);
    });
  }

  it('fails on PEM and JWK private keys (SA signing keys)', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = String(privateKey.export({ format: 'pem', type: 'pkcs8' }));
    const jwk = privateKey.export({ format: 'jwk' });
    for (const [file, contents, rule] of /** @type {Array<[string, string, string]>} */ ([
      ['keys/sa-signing.pem', pem, 'blackwing-pem-private-key'],
      [
        'keys/sa-signing.jwk.json',
        `${JSON.stringify(jwk, undefined, 2)}\n`,
        'blackwing-jwk-private-key',
      ],
    ])) {
      const repo = new TempRepo();
      repo.write(file, contents);
      repo.commit('chore: add key');
      const result = repo.scan();
      assert.equal(result.status, 1, `${file}: ${result.output}`);
      assert.ok(rulesOf(result).includes(rule), `${file}: ${rulesOf(result).join(',')}`);
      assert.ok(typeof jwk.d === 'string');
      assertNeverPrinted(result, jwk.d);
    }
  });

  it('fails on hard-coded OpenBao, MinIO, Keycloak and signing-key credentials', () => {
    /** @type {Array<[string, string, string]>} */
    const cases = [
      ['BAO_TOKEN', `hvs.${randomBytes(18).toString('base64url')}`, 'openbao-token'],
      ['MINIO_ROOT_PASSWORD', fakePassword(), 'minio-credentials'],
      ['KC_BOOTSTRAP_ADMIN_PASSWORD', fakePassword(), 'keycloak-credentials'],
      ['BW_DEV_GOOGLE_CLIENT_SECRET', fakePassword(), 'keycloak-credentials'],
      ['BW_SA_SIGNING_KEY', randomBytes(32).toString('base64'), 'blackwing-signing-key-assignment'],
    ];
    for (const [name, value, rule] of cases) {
      const repo = new TempRepo();
      repo.write('infra/compose/.env', `${name}=${value}\n`);
      repo.commit('chore: add env');
      const result = repo.scan();
      assert.equal(result.status, 1, `${name}: ${result.output}`);
      assert.ok(rulesOf(result).includes(rule), `${name}: ${rulesOf(result).join(',')}`);
      assertNeverPrinted(result, value);
    }
  });

  it('does not flag credentials read from variables or left empty (false positives)', () => {
    const repo = new TempRepo();
    repo.write(
      'packages/testing/src/minio.ts',
      'const env = { MINIO_ROOT_PASSWORD: credentials.secretAccessKey };\n',
    );
    repo.write(
      'infra/compose/docker-compose.dev.yml',
      'environment:\n  MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}\n  KC_BOOTSTRAP_ADMIN_PASSWORD: ${KC_ADMIN_PW:?set it}\n',
    );
    repo.write(
      '.env.example',
      ['BW_DEV_GOOGLE_CLIENT_SECRET=', 'MINIO_ROOT_PASSWORD=', ''].join('\n'),
    );
    // Shell `${VAR:?message}` / `${VAR:+alt}` expansions name a variable, not a value.
    repo.write(
      'infra/compose/minio/bootstrap.sh',
      [
        ': "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"',
        ': "${KC_BOOTSTRAP_ADMIN_PASSWORD:+KC_BOOTSTRAP_ADMIN_PASSWORD_SET}"',
        '',
      ].join('\n'),
    );
    // An escaped newline inside a string literal is not a value.
    repo.write('src/escaped.json', String.raw`{"env": "KC_DB_PASSWORD=\nNEXT_VARIABLE=1"}` + '\n');
    repo.commit('chore: add config');
    const result = repo.scan();
    assert.equal(result.status, 0, result.output);
  });

  it('passes an allowlisted fixture (the committed fixture directory)', () => {
    const repo = new TempRepo();
    repo.write(ALLOWED_FIXTURE, readFileSync(path.join(REPO_ROOT, ALLOWED_FIXTURE), 'utf8'));
    repo.write('packages/logger/src/redaction.test.ts', `const pat = '${fakeToken('bw_pat')}';\n`);
    repo.commit('test: add fixtures');
    const result = repo.scan();
    assert.equal(result.status, 0, result.output);
    assert.equal(countFindings(result.sarif).total, 0);
  });

  it('keeps the allowlist narrow: the same fake token outside an allowlisted path fails', () => {
    const repo = new TempRepo();
    const token = fakeToken('bw_pat');
    repo.write('apps/api/src/auth.test.ts', `const pat = '${token}';\n`);
    repo.write('scripts/fixtures/gitleaks/other/creds.txt', `${fakeToken('bw_ci')}\n`);
    repo.commit('test: add auth test');
    const result = repo.scan();
    assert.equal(result.status, 1, result.output);
    assert.equal(countFindings(result.sarif).total, 2);
  });

  it('scopes a PR/push scan to the diff, while the full-history scan finds historical secrets', () => {
    const repo = new TempRepo();
    const token = fakeToken('bw_pat');
    repo.write('old.txt', `${token}\n`);
    repo.commit('chore: leak (historical)');
    repo.write('old.txt', 'rotated and removed\n');
    const base = repo.commit('chore: remove leak');
    repo.write('README.md', 'clean change\n');
    const head = repo.commit('docs: readme');

    const diff = repo.scan(['--log-opts', `${base}..${head}`]);
    assert.equal(diff.status, 0, diff.output);

    const full = repo.scan();
    assert.equal(full.status, 1, full.output);
    assert.deepEqual(rulesOf(full), ['blackwing-personal-access-token']);
    assertNeverPrinted(full, token);

    repo.write('new.txt', `${fakeToken('bwk')}\n`);
    const leakHead = repo.commit('chore: new leak');
    const prScan = repo.scan(['--log-opts', `${head}..${leakHead}`]);
    assert.equal(prScan.status, 1, prScan.output);
    assert.deepEqual(rulesOf(prScan), ['blackwing-virtual-model-key']);
  });

  it('blocks a staged secret with the pre-commit command (same ruleset)', () => {
    const repo = new TempRepo();
    const token = fakeToken('bw_ci');
    repo.write('ci.env', `BW_TOKEN=${token}\n`);
    repo.git(['add', 'ci.env']);
    const result = runGitleaks(repo.dir, ['protect', '--staged', '--source', repo.dir]);
    assert.equal(result.status, 1, result.output);
    assertNeverPrinted(result, token);
  });

  it("finds nothing in this repository's full history (the weekly scan stays green)", () => {
    const result = runGitleaks(REPO_ROOT, ['detect', '--source', REPO_ROOT]);
    assert.equal(
      result.status,
      0,
      `rotate and remove, or justify an allowlist entry:\n${result.output}`,
    );
  });
});

describe('secret-scan wiring', () => {
  const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/secret-scan.yml'), 'utf8');
  const hook = readFileSync(path.join(REPO_ROOT, '.husky/pre-commit'), 'utf8');

  it('always redacts and always uses the shared config', () => {
    const invocations = [
      ...`${workflow}\n${hook}`.matchAll(/^\s*(?:args=\(|gitleaks )(detect|protect).*$/gm),
    ];
    assert.ok(invocations.length >= 2, 'expected the CI and pre-commit invocations');
    for (const [line] of invocations) {
      assert.match(line, /--redact/, line);
      assert.match(line, /--config \.gitleaks\.toml/, line);
    }
  });

  it('scans PR diffs, weekly full history, uploads SARIF and fails on findings', () => {
    assert.match(workflow, /^\s+pull_request:/m);
    assert.match(workflow, /^\s+schedule:\n\s+- cron: '[^']+'/m);
    assert.match(workflow, /--log-opts "\$range"/);
    assert.match(workflow, /range="\$\{PR_BASE\}\.\.\$\{PR_HEAD\}"/);
    assert.match(workflow, /github\/codeql-action\/upload-sarif@[0-9a-f]{40}/);
    assert.match(workflow, /security-events: write/);
    assert.match(workflow, /--exit-code 1/);
    assert.match(workflow, /sha256sum -c/);
  });

  it('makes .gitleaks.toml security-owned (CODEOWNERS)', () => {
    const owners = readFileSync(path.join(REPO_ROOT, '.github/CODEOWNERS'), 'utf8');
    assert.match(owners, /^\/\.gitleaks\.toml\s+@TinycrowsLab\/blackwing-security-owners$/m);
  });
});
