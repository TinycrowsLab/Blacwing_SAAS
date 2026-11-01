// Tests for the bw-sandbox tool-manifest generator (IMAGE-008, #606). The real pins must produce a complete, sorted,
// byte-stable manifest. Each failure mode the build must catch (a planted binary, a missing or unpinned tool, a
// symlink in the bin directory, a bad epoch) must fail with a clear error.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { REPO_ROOT } from './test-fixtures.mjs';
import {
  buildToolManifest,
  canonicalJson,
  listInstalled,
  main,
  sha256File,
} from '../infra/docker/sandbox/tools/gen-manifest.mjs';

/**
 * @typedef {{ name: string, version: string, licence: string, source: string, entrypoint?: string, binarySha256: string }} PinTool
 * @typedef {{ tools: PinTool[], browser: { playwright: string, chromium: { revision: string, version: string } } }} Pins
 */

const SANDBOX = path.join(REPO_ROOT, 'infra/docker/sandbox');
/** @param {string} file @returns {unknown} */
const readPin = (file) => JSON.parse(readFileSync(path.join(SANDBOX, file), 'utf8'));
/** @param {string} text @returns {unknown} */
const parseJson = (text) => {
  /** @type {unknown} */
  const value = JSON.parse(text);
  return value;
};
/** @param {string} file @returns {Pins} */
const pinsFile = (file) => /** @type {Pins} */ (readPin(file));
const BASE_IMAGE = 'node:22-bookworm-slim@sha256:' + 'c'.repeat(64);
const EPOCH = '1767225600'; // 2026-01-01T00:00:00Z

/** @type {string[]} */
const tmpDirs = [];
const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bw-gen-manifest-'));
  tmpDirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const templatesPin = {
  name: 'nuclei-templates',
  version: '10.5.1',
  commit: '79fb682760ab3d5b0e22afbb44709353cbebf023',
  treeSha256: '2f50bf9c75b25580281b57845e342a3cc35711a48e408b35a322d566e4cac1da',
};

/**
 * The installed map the real image would produce: every pinned entrypoint, measured at its pinned digest.
 * @param {Pins} toolsPin
 * @param {Pins} scannersPin
 * @returns {Map<string, string>}
 */
function installedFromPins(toolsPin, scannersPin) {
  /** @type {Map<string, string>} */
  const installed = new Map();
  for (const t of [...toolsPin.tools, ...scannersPin.tools]) {
    installed.set(t.entrypoint ?? t.name, t.binarySha256);
  }
  return installed;
}

/** @param {Partial<Parameters<typeof buildToolManifest>[0]>} [overrides] */
const build = (overrides = {}) => {
  const toolsPin = pinsFile('tools.pin.json');
  const scannersPin = pinsFile('scanners.pin.json');
  return buildToolManifest({
    toolsPin,
    scannersPin,
    installed: installedFromPins(toolsPin, scannersPin),
    templatesPin,
    baseImage: BASE_IMAGE,
    sourceDateEpoch: EPOCH,
    ...overrides,
  });
};

describe('buildToolManifest with the real pins', () => {
  it('lists every pinned tool once, sorted by name, with version, sha256, licence and source', () => {
    const manifest = build();
    const names = manifest.tools.map((t) => t.name);
    assert.equal(names.length, 14);
    assert.deepEqual(names, [...names].sort());
    assert.equal(new Set(names).size, names.length);
    for (const tool of manifest.tools) {
      assert.match(tool.sha256, /^[0-9a-f]{64}$/, tool.name);
      assert.ok(tool.version.length > 0, tool.name);
      assert.ok(tool.licence.length > 0, tool.name);
      assert.match(tool.source, /^https:\/\//, tool.name);
    }
    const nuclei = pinsFile('tools.pin.json').tools.find((t) => t.name === 'nuclei');
    assert.deepEqual(
      manifest.tools.find((t) => t.name === 'nuclei'),
      {
        name: 'nuclei',
        version: '3.11.1',
        sha256: nuclei?.binarySha256,
        licence: 'MIT',
        source: 'https://github.com/projectdiscovery/nuclei',
      },
    );
  });

  it('records the base digest, template commit, Playwright and Chromium pins, and leaves imageDigest for IMAGE-012', () => {
    const manifest = build();
    const tools = pinsFile('tools.pin.json');
    assert.equal(manifest.imageBaseDigest, 'sha256:' + 'c'.repeat(64));
    assert.equal(manifest.imageDigest, null);
    assert.equal(manifest.nucleiTemplatesCommit, templatesPin.commit);
    assert.equal(manifest.playwrightVersion, tools.browser.playwright);
    assert.equal(manifest.chromiumRevision, tools.browser.chromium.revision);
  });

  it('derives generatedAt from SOURCE_DATE_EPOCH', () => {
    assert.equal(build().generatedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(build({ sourceDateEpoch: '0' }).generatedAt, '1970-01-01T00:00:00.000Z');
  });

  it('is byte-stable across two identical builds', () => {
    assert.equal(canonicalJson(build()), canonicalJson(build()));
  });

  it('serialises with sorted keys and a trailing newline', () => {
    const text = canonicalJson(build());
    assert.ok(text.endsWith('}\n'));
    const parsed = /** @type {{ tools: Record<string, unknown>[] }} */ (parseJson(text));
    assert.deepEqual(Object.keys(parsed), Object.keys(parsed).sort());
    assert.deepEqual(Object.keys(parsed.tools[0] ?? {}), [
      'licence',
      'name',
      'sha256',
      'source',
      'version',
    ]);
  });
});

describe('buildToolManifest failure modes', () => {
  const real = () => {
    const toolsPin = pinsFile('tools.pin.json');
    const scannersPin = pinsFile('scanners.pin.json');
    return { toolsPin, scannersPin, installed: installedFromPins(toolsPin, scannersPin) };
  };
  /** @param {ReturnType<typeof real>} input */
  const attempt = (input) =>
    buildToolManifest({ ...input, templatesPin, baseImage: BASE_IMAGE, sourceDateEpoch: EPOCH });

  it('fails when an installed binary does not match its pinned sha256 (planted or tampered binary)', () => {
    const input = real();
    input.installed.set('httpx', 'd'.repeat(64));
    assert.throws(() => attempt(input), /httpx: installed httpx sha256 .* does not match pinned/);
  });

  it('fails when a pinned tool is not installed', () => {
    const input = real();
    input.installed.delete('nuclei');
    assert.throws(() => attempt(input), /nuclei: pinned entrypoint nuclei is not installed/);
  });

  it('fails when an installed file is not pinned (the manifest must be complete)', () => {
    const input = real();
    input.installed.set('curl', 'e'.repeat(64));
    assert.throws(() => attempt(input), /curl: installed in the bin directory but not pinned/);
  });

  it('fails when one entrypoint is pinned twice', () => {
    const input = real();
    const first = input.toolsPin.tools[0];
    assert.ok(first);
    input.toolsPin.tools.push({ ...first });
    assert.throws(() => attempt(input), /entrypoint pinned 2 times/);
  });

  it('fails on a pin without a binarySha256', () => {
    const input = real();
    const first = input.toolsPin.tools[0];
    assert.ok(first);
    /** @type {Partial<PinTool>} */ (first).binarySha256 = undefined;
    assert.throws(() => attempt(input), /binarySha256 must be 64 lowercase hex/);
  });

  it('fails on a non-https source and on a missing licence', () => {
    const input = real();
    const [first, second] = input.toolsPin.tools;
    assert.ok(first && second);
    first.source = 'http://example.test/subfinder';
    second.licence = '';
    assert.throws(
      () => attempt(input),
      /subfinder: source must be an https URL[\s\S]*licence is required/,
    );
  });

  it('fails when the template pin has no 40-hex commit', () => {
    assert.throws(
      () => build({ templatesPin: { ...templatesPin, commit: 'main' } }),
      /40-hex commit/,
    );
  });

  it('fails when the base image is not digest-pinned', () => {
    assert.throws(() => build({ baseImage: 'node:22-bookworm-slim' }), /pinned by @sha256: digest/);
  });

  for (const epoch of ['', 'abc', '-1', '1.5', '99999999999999']) {
    it(`fails on SOURCE_DATE_EPOCH ${JSON.stringify(epoch)}`, () => {
      assert.throws(
        () => build({ sourceDateEpoch: epoch }),
        /SOURCE_DATE_EPOCH must be a non-negative integer/,
      );
    });
  }

  it('reports every violation at once', () => {
    const input = real();
    input.installed.set('httpx', 'd'.repeat(64));
    input.installed.delete('nuclei');
    assert.throws(() => attempt(input), /gen-manifest: 2 problem\(s\)/);
  });
});

describe('listInstalled and sha256File', () => {
  it('hashes a file exactly as crypto does', () => {
    const dir = tmp();
    const file = path.join(dir, 'bin');
    const bytes = Buffer.from('bw-sandbox tool bytes\n'.repeat(4096));
    writeFileSync(file, bytes);
    assert.equal(sha256File(file), createHash('sha256').update(bytes).digest('hex'));
  });

  it('lists regular files by name', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'jq'), 'x');
    writeFileSync(path.join(dir, 'ffuf'), 'y');
    assert.deepEqual([...listInstalled(dir).keys()], ['ffuf', 'jq']);
  });

  it('refuses a symlink in the bin directory, which could point outside the verified tree', () => {
    const dir = tmp();
    symlinkSync('/etc/passwd', path.join(dir, 'jq'));
    assert.throws(() => listInstalled(dir), /not a regular file/);
  });

  it('refuses a sub-directory in the bin directory', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'nested'));
    assert.throws(() => listInstalled(dir), /not a regular file/);
  });
});

describe('main (end to end on a fabricated image tree)', () => {
  /**
   * Lays out bin/, templates/ and pin copies in a temp dir and returns the argv for main().
   * @param {{ tamper?: boolean }} [options]
   */
  function layout({ tamper = false } = {}) {
    const root = tmp();
    const bin = path.join(root, 'bin');
    const templates = path.join(root, 'templates');
    mkdirSync(bin);
    mkdirSync(templates);
    const toolsPin = pinsFile('tools.pin.json');
    const scannersPin = pinsFile('scanners.pin.json');
    for (const t of [...toolsPin.tools, ...scannersPin.tools]) {
      // Fabricated bytes never hash to the real pins, so the happy path is covered by the unit tests above; this
      // layout exercises the mismatch path through the CLI.
      writeFileSync(path.join(bin, t.entrypoint ?? t.name), `fake ${t.name}\n`);
    }
    if (tamper) writeFileSync(path.join(bin, 'httpx'), 'planted');
    writeFileSync(path.join(templates, '.bw-template-pin.json'), JSON.stringify(templatesPin));
    writeFileSync(path.join(root, 'tools.pin.json'), JSON.stringify(toolsPin));
    writeFileSync(path.join(root, 'scanners.pin.json'), JSON.stringify(scannersPin));
    return {
      out: path.join(root, 'tool-manifest.json'),
      argv: [
        '--tools-pin',
        path.join(root, 'tools.pin.json'),
        '--scanners-pin',
        path.join(root, 'scanners.pin.json'),
        '--bin-dir',
        bin,
        '--templates-dir',
        templates,
        '--base-image',
        BASE_IMAGE,
        '--out',
        path.join(root, 'tool-manifest.json'),
      ],
    };
  }

  it('fails the build and writes nothing when the installed binaries do not match the pins', () => {
    const { argv, out } = layout();
    const previous = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = EPOCH;
    try {
      assert.throws(() => {
        main(argv);
      }, /does not match pinned/);
    } finally {
      if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
      else process.env.SOURCE_DATE_EPOCH = previous;
    }
    assert.throws(() => readFileSync(out), /ENOENT/);
  });

  it('requires SOURCE_DATE_EPOCH', () => {
    const { argv } = layout({ tamper: true });
    const previous = process.env.SOURCE_DATE_EPOCH;
    delete process.env.SOURCE_DATE_EPOCH;
    try {
      assert.throws(() => {
        main(argv);
      }, /SOURCE_DATE_EPOCH must be set/);
    } finally {
      if (previous !== undefined) process.env.SOURCE_DATE_EPOCH = previous;
    }
  });
});
