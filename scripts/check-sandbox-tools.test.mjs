// Tests for the pinned sandbox toolchain guard (IMAGE-002, #601). The real scanners.pin.json must pass, and
// each mutation (a missing checksum, a forbidden tool, a raw sqlmap on PATH, a wrong licence) must fail.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { checkToolPins, FORBIDDEN_TOOLS, REQUIRED_SCANNERS } from './check-sandbox-tools.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';

const PIN_PATH = path.join(REPO_ROOT, 'infra/docker/sandbox/scanners.pin.json');

/**
 * @typedef {{
 *   name: string, version: string, licence: string, source: string, entrypoint: string,
 *   versionArgs: string[],
 *   install: { kind: string, member?: string, entry?: string, shim?: boolean, module?: string, package?: string, zipHash?: string },
 *   artifacts: Record<string, { url: string, sha256: string }>
 * }} Tool
 * @typedef {{ schema: number, binDir: string, libDir: string, tools: Tool[], system: { name: string, version: string, licence: string }[] }} Pins
 */

/** @returns {Pins} a fresh deep copy of the real pin file, safe to mutate */
const load = () => {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
  return /** @type {Pins} */ (parsed);
};

/**
 * @param {Pins} pins
 * @param {string} name
 * @returns {Tool}
 */
const toolOf = (pins, name) => {
  const tool = pins.tools.find((t) => t.name === name);
  assert.ok(tool, `fixture has ${name}`);
  return tool;
};

describe('real scanners.pin.json', () => {
  it('passes the guard', () => {
    assert.deepEqual(checkToolPins(load()), []);
  });

  it('pins every required tool with a licence the review expects', () => {
    const pins = load();
    for (const [name, licence] of Object.entries(REQUIRED_SCANNERS)) {
      assert.equal(toolOf(pins, name).licence, licence, name);
    }
  });

  it('never lists a forbidden tool (nmap, semgrep)', () => {
    const names = load().tools.map((/** @type {{name: string}} */ t) => t.name);
    for (const forbidden of FORBIDDEN_TOOLS) assert.ok(!names.includes(forbidden), forbidden);
  });
});

describe('checkToolPins mutations', () => {
  it('fails on a malformed sha256 (mutation: truncated digest)', () => {
    const pins = load();
    const ffuf = toolOf(pins, 'ffuf').artifacts.amd64;
    assert.ok(ffuf);
    ffuf.sha256 = 'b2a3c725';
    assert.ok(
      checkToolPins(pins).some((e) => e.includes('ffuf') && e.includes('sha256 must be 64')),
    );
  });

  it('fails when a binary tool is missing its arm64 digest', () => {
    const pins = load();
    delete toolOf(pins, 'jq').artifacts.arm64;
    assert.ok(
      checkToolPins(pins).some((e) => e.includes('jq') && e.includes('missing artifacts.arm64')),
    );
  });

  it('fails on a non-https download URL', () => {
    const pins = load();
    const trivy = toolOf(pins, 'trivy').artifacts.amd64;
    assert.ok(trivy);
    trivy.url = 'http://example.test/trivy.tar.gz';
    assert.ok(checkToolPins(pins).some((e) => e.includes('trivy') && e.includes('must be https')));
  });

  it('fails when a required tool is missing (mutation: gitleaks removed)', () => {
    const pins = load();
    pins.tools = pins.tools.filter((/** @type {{name: string}} */ t) => t.name !== 'gitleaks');
    assert.ok(checkToolPins(pins).some((e) => e.includes('missing required tool gitleaks')));
  });

  it('fails when nmap is added (licence review gate)', () => {
    const pins = load();
    pins.tools.push({ ...toolOf(pins, 'jq'), name: 'nmap', licence: 'NPSL' });
    assert.ok(checkToolPins(pins).some((e) => e.includes('nmap: forbidden tool')));
  });

  it('fails when semgrep is added (registry rules licence)', () => {
    const pins = load();
    pins.tools.push({ ...toolOf(pins, 'jq'), name: 'semgrep', licence: 'LGPL-2.1-only' });
    assert.ok(checkToolPins(pins).some((e) => e.includes('semgrep: forbidden tool')));
  });

  it('fails when a tool declares the wrong licence', () => {
    const pins = load();
    toolOf(pins, 'testssl.sh').licence = 'MIT';
    assert.ok(
      checkToolPins(pins).some((e) => e.includes('testssl.sh: licence must be GPL-2.0-only')),
    );
  });

  it('fails when sqlmap gets a PATH shim (raw sqlmap must never be on PATH)', () => {
    const pins = load();
    const sqlmap = toolOf(pins, 'sqlmap');
    sqlmap.install.shim = true;
    sqlmap.entrypoint = 'sqlmap';
    const errors = checkToolPins(pins);
    assert.ok(errors.some((e) => e.includes('sqlmap must not get a PATH shim')));
    assert.ok(errors.some((e) => e.includes('must be reached only through bw-sqlmap')));
  });

  it('fails when a Go tool has no h1 module zip hash', () => {
    const pins = load();
    toolOf(pins, 'fingerprintx').install.zipHash = 'sha256:abc';
    assert.ok(
      checkToolPins(pins).some((e) =>
        e.includes('fingerprintx: go install needs an h1: install.zipHash'),
      ),
    );
  });

  it('fails when a Go tool declares artifacts it does not use', () => {
    const pins = load();
    toolOf(pins, 'fingerprintx').artifacts = {
      all: { url: 'https://example.test/x', sha256: 'a'.repeat(64) },
    };
    assert.ok(checkToolPins(pins).some((e) => e.includes('go install must not declare artifacts')));
  });

  it('fails when an arch-specific artifact is mixed with an all artifact', () => {
    const pins = load();
    const testssl = toolOf(pins, 'testssl.sh');
    testssl.artifacts.amd64 = { url: 'https://example.test/x', sha256: 'a'.repeat(64) };
    assert.ok(checkToolPins(pins).some((e) => e.includes('artifacts.all cannot be combined')));
  });

  it('fails when a system package (python3, bash, openssl) has no recorded version', () => {
    const pins = load();
    pins.system = pins.system.filter((/** @type {{name: string}} */ s) => s.name !== 'python3');
    assert.ok(
      checkToolPins(pins).some((e) => e.includes('system package python3 is not recorded')),
    );
  });

  it('fails when the schema or the bin directory drifts from /opt/bw/tools', () => {
    const pins = load();
    pins.binDir = '/usr/local/bin';
    pins.schema = 2;
    const errors = checkToolPins(pins);
    assert.ok(errors.some((e) => e.includes('binDir must be')));
    assert.ok(errors.some((e) => e.includes('schema must be 1')));
  });

  it('fails on a tool not in the required set (unreviewed tool)', () => {
    const pins = load();
    pins.tools.push({ ...toolOf(pins, 'jq'), name: 'masscan' });
    assert.ok(checkToolPins(pins).some((e) => e.includes('masscan: not a required sandbox tool')));
  });

  it('does not treat prototype keys as pinned tools', () => {
    const pins = load();
    pins.tools.push({ ...toolOf(pins, 'jq'), name: 'constructor' });
    assert.ok(
      checkToolPins(pins).some((e) => e.includes('constructor: not a required sandbox tool')),
    );
  });

  it('rejects a non-object document', () => {
    assert.deepEqual(checkToolPins(null), ['scanners.pin.json must be a JSON object']);
  });
});
