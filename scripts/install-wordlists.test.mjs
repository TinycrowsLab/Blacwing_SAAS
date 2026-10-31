// Tests for the bundled wordlists (IMAGE-006, #604). The real pin must pass, the installer must copy the lists
// verbatim, and each mutation (a checksum mismatch, a licence off the allowlist, a missing licence text, a
// non-UTF-8 list, an oversized set, a path escape, an unlisted file, a dropped Dockerfile wire) must fail.

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { checkRepo } from './check-sandbox-image.mjs';
import { checkWordlistsRepo } from './check-sandbox-wordlists.mjs';
import { REPO_ROOT } from './test-fixtures.mjs';
import {
  ALLOWED_LICENCES,
  checkWordlistPin,
  installWordlists,
  sha256Hex,
} from '../infra/docker/sandbox/tools/install-wordlists.mjs';

const SANDBOX = path.join(REPO_ROOT, 'infra/docker/sandbox');
const PIN_PATH = path.join(SANDBOX, 'wordlists.pin.json');
const MIB = 1024 * 1024;
const COMMIT = '0008f4343439b48257c0815fc797955d0ab1e755';
const LIST_BYTES = Buffer.from('admin\nlogin\nüber\r\n', 'utf8');
const LICENCE_BYTES = Buffer.from('MIT License\n');

/**
 * @typedef {{
 *   schema: number,
 *   licences: Array<{ licence: string, file: string, sha256: string }>,
 *   lists: Array<{ name: string, category: string, file: string, sha256: string, version: string, licence: string, source: string }>
 * }} RealPin
 */
/** @param {string} text @returns {unknown} */
const parseJson = (text) => JSON.parse(text);

/** @type {string[]} */
const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});
/** @param {string} prefix */
const tmpDir = (prefix) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
};

/**
 * A small in-memory pin plus the bytes it names, so each mutation changes exactly one thing.
 * @param {(p: Record<string, unknown>, files: Map<string, Buffer>) => void} [mutate]
 */
function fixture(mutate) {
  const files = new Map([
    ['wordlists/LICENSE.x', LICENCE_BYTES],
    ['wordlists/web-content/a.txt', LIST_BYTES],
  ]);
  /** @type {Record<string, unknown>} */
  const pin = {
    schema: 1,
    licences: [
      {
        licence: 'MIT',
        file: 'wordlists/LICENSE.x',
        sha256: sha256Hex(LICENCE_BYTES),
      },
    ],
    lists: [
      {
        name: 'a',
        category: 'web-content',
        file: 'wordlists/web-content/a.txt',
        sha256: sha256Hex(LIST_BYTES),
        version: COMMIT,
        licence: 'MIT',
        source: `https://github.com/example/repo/blob/${COMMIT}/a.txt`,
      },
    ],
  };
  mutate?.(pin, files);
  return { pin, files, readBytes: (/** @type {string} */ rel) => files.get(rel) };
}

/** @param {unknown} pin @param {Map<string, Buffer>} files @param {number} [maxMib] */
const check = (pin, files, maxMib) => checkWordlistPin(pin, (rel) => files.get(rel), maxMib).errors;

describe('wordlists.pin.json (real pin)', () => {
  it('passes the pin, the vendored bytes and the Dockerfile wiring', () => {
    assert.deepEqual(checkWordlistsRepo(REPO_ROOT, {}), []);
  });

  it('is covered by the image guard', () => {
    assert.deepEqual(checkRepo(REPO_ROOT), []);
  });

  it('installs every list byte-for-byte with a manifest entry and licence text', () => {
    const dst = tmpDir('bw-wordlists-');
    const { lists, totalBytes } = installWordlists(PIN_PATH, dst);
    assert.equal(lists, 3);
    assert.ok(totalBytes > 0 && totalBytes <= 64 * MIB);
    const pin = /** @type {RealPin} */ (parseJson(readFileSync(PIN_PATH, 'utf8')));
    for (const l of pin.lists) {
      const src = readFileSync(path.join(SANDBOX, l.file));
      const out = readFileSync(path.join(dst, l.category, path.basename(l.file)));
      assert.deepEqual(out, src, `${l.name} must be copied verbatim`);
      assert.equal(sha256Hex(out), l.sha256);
    }
    const manifest =
      /** @type {{ lists: Array<{ name: string, sha256: string, licence: string, source: string, version: string }>, licences: Array<{ licence: string, file: string }> }} */ (
        parseJson(readFileSync(path.join(dst, 'manifest.json'), 'utf8'))
      );
    assert.equal(manifest.lists.length, 3);
    for (const l of manifest.lists) {
      assert.ok(
        l.name && l.sha256 && l.licence && l.source && l.version,
        `${l.name} manifest entry`,
      );
      assert.match(l.version, /^[0-9a-f]{40}$/);
    }
    assert.equal(manifest.licences[0].licence, 'MIT');
    assert.equal(
      readFileSync(path.join(dst, manifest.licences[0].file), 'utf8').includes('MIT License'),
      true,
    );
  });

  it('keeps the allowlist to permissive licences only', () => {
    for (const l of [
      'GPL-2.0-only',
      'GPL-3.0-only',
      'AGPL-3.0-only',
      'CC-BY-SA-4.0',
      'NOASSERTION',
    ]) {
      assert.ok(!ALLOWED_LICENCES.includes(l), `${l} must not be allowed`);
    }
  });
});

describe('checkWordlistPin', () => {
  it('accepts a well-formed pin with one list', () => {
    const { pin, files } = fixture();
    assert.deepEqual(check(pin, files), []);
  });

  it('rejects a licence outside the allowlist, even when recorded', () => {
    const { pin, files } = fixture((p) => {
      p.licences = [
        { licence: 'GPL-3.0-only', file: 'wordlists/LICENSE.x', sha256: sha256Hex(LICENCE_BYTES) },
      ];
      p.lists = [{ .../** @type {object[]} */ (p.lists)[0], licence: 'GPL-3.0-only' }];
    });
    const errors = check(pin, files);
    assert.ok(errors.some((e) => e.includes('GPL-3.0-only is not on the allowlist')));
  });

  it('rejects a list whose licence has no licence text recorded (ambiguous or missing licence)', () => {
    const { pin, files } = fixture((p) => {
      p.licences = [];
    });
    assert.ok(check(pin, files).some((e) => e.includes('has no licence text recorded')));
  });

  it('rejects a list with a missing licence field', () => {
    const { pin, files } = fixture((p) => {
      delete (/** @type {Record<string, unknown>[]} */ (p.lists)[0].licence);
    });
    assert.ok(check(pin, files).some((e) => e.includes('not on the allowlist')));
  });

  it('rejects a list whose bytes do not match the pinned sha256', () => {
    const { pin, files } = fixture((_p, f) => {
      f.set('wordlists/web-content/a.txt', Buffer.from('tampered\n'));
    });
    assert.ok(check(pin, files).some((e) => e.includes('sha256 mismatch')));
  });

  it('rejects a list whose file is missing', () => {
    const { pin, files } = fixture((_p, f) => f.delete('wordlists/web-content/a.txt'));
    assert.ok(check(pin, files).some((e) => e.includes('is missing')));
  });

  it('rejects a list that is not valid UTF-8, without transforming it', () => {
    const bad = Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x0a]);
    const { pin, files } = fixture((p, f) => {
      f.set('wordlists/web-content/a.txt', bad);
      /** @type {Record<string, unknown>[]} */ (p.lists)[0].sha256 = sha256Hex(bad);
    });
    assert.ok(check(pin, files).some((e) => e.includes('not valid UTF-8')));
  });

  it('accepts UTF-8 entries verbatim (unicode and CRLF are kept)', () => {
    const { pin, files } = fixture();
    assert.deepEqual(check(pin, files), []);
    assert.equal(
      files.get('wordlists/web-content/a.txt')?.toString('utf8').includes('\u00fcber\r\n'),
      true,
    );
  });

  it('rejects a total above IMAGE_WORDLISTS_MAX_MIB', () => {
    const big = Buffer.alloc(MIB + 1, 0x61);
    const { pin, files } = fixture((p, f) => {
      f.set('wordlists/web-content/a.txt', big);
      /** @type {Record<string, unknown>[]} */ (p.lists)[0].sha256 = sha256Hex(big);
    });
    assert.ok(check(pin, files, 1).some((e) => e.includes('exceeds IMAGE_WORDLISTS_MAX_MIB=1')));
    assert.deepEqual(check(pin, files, 2), []);
  });

  it('rejects path escapes and absolute paths in list and licence files', () => {
    for (const bad of [
      '../etc/passwd.txt',
      '/etc/passwd.txt',
      'wordlists/../../x.txt',
      'other/a.txt',
      'wordlists/a.bin',
    ]) {
      const { pin, files } = fixture((p) => {
        /** @type {Record<string, unknown>[]} */ (p.lists)[0].file = bad;
      });
      assert.ok(
        check(pin, files).some((e) => e.includes('file must be a .txt path under wordlists/')),
        bad,
      );
    }
  });

  it('rejects a duplicate list name and a duplicate file', () => {
    const { pin, files } = fixture((p) => {
      const first = /** @type {Record<string, unknown>[]} */ (p.lists)[0];
      p.lists = [first, { ...first }];
    });
    const errors = check(pin, files);
    assert.ok(errors.some((e) => e.includes('a: listed twice')));
    assert.ok(errors.some((e) => e.includes('file wordlists/web-content/a.txt is listed twice')));
  });

  it('rejects a non-commit version, a malformed sha256 and a non-https source', () => {
    const { pin, files } = fixture((p) => {
      const l = /** @type {Record<string, unknown>[]} */ (p.lists)[0];
      l.version = 'main';
      l.sha256 = 'ABC';
      l.source = 'http://example.com/a.txt';
    });
    const errors = check(pin, files);
    assert.ok(errors.some((e) => e.includes('version must be the 40-hex upstream commit')));
    assert.ok(errors.some((e) => e.includes('sha256 must be 64 lowercase hex')));
    assert.ok(errors.some((e) => e.includes('source must be an https URL')));
  });

  it('rejects an empty list set, a wrong schema and an empty list file', () => {
    const { files } = fixture();
    assert.ok(check({ schema: 2, licences: [], lists: [] }, files).length > 0);
    assert.ok(
      check({ schema: 1, licences: [], lists: [] }, files).some((e) => e.includes('non-empty')),
    );
    const empty = Buffer.from('\n\n');
    const bad = fixture((p, f) => {
      f.set('wordlists/web-content/a.txt', empty);
      /** @type {Record<string, unknown>[]} */ (p.lists)[0].sha256 = sha256Hex(empty);
    });
    assert.ok(check(bad.pin, bad.files).some((e) => e.includes('has no entries')));
  });

  it('rejects a licence file whose bytes differ from the pinned sha256', () => {
    const { pin, files } = fixture((_p, f) => f.set('wordlists/LICENSE.x', Buffer.from('other')));
    assert.ok(
      check(pin, files).some((e) =>
        e.includes('licence file wordlists/LICENSE.x: sha256 mismatch'),
      ),
    );
  });
});

describe('installWordlists refuses to install a bad set', () => {
  it('throws on a tampered list and writes nothing', () => {
    const src = tmpDir('bw-wl-src-');
    cpSync(SANDBOX, src, { recursive: true });
    writeFileSync(path.join(src, 'wordlists/web-content/common.txt'), 'tampered\n');
    const dst = tmpDir('bw-wl-dst-');
    assert.throws(
      () => installWordlists(path.join(src, 'wordlists.pin.json'), dst),
      /sha256 mismatch/,
    );
    assert.equal(readdirSync(dst).length, 0, 'a failed verification must not write the lists');
  });
});

describe('checkWordlistsRepo on a changed tree', () => {
  /** @returns {string} a copy of the sandbox wiring in a temp root */
  const copyRoot = () => {
    const root = tmpDir('bw-wl-root-');
    cpSync(path.join(REPO_ROOT, 'infra'), path.join(root, 'infra'), { recursive: true });
    return root;
  };

  it('fails on a file that no pin entry lists', () => {
    const root = copyRoot();
    writeFileSync(path.join(root, 'infra/docker/sandbox/wordlists/web-content/extra.txt'), 'x\n');
    assert.ok(
      checkWordlistsRepo(root, {}).some((e) => e.includes('web-content/extra.txt is not listed')),
    );
  });

  it('fails when the Dockerfile stops building or copying the lists', () => {
    const root = copyRoot();
    const df = path.join(root, 'infra/docker/sandbox/Dockerfile');
    writeFileSync(
      df,
      readFileSync(df, 'utf8').replace(
        /^COPY --from=tools --chown=root:root \/opt\/bw\/wordlists.*$/m,
        '',
      ),
    );
    assert.ok(
      checkWordlistsRepo(root, {}).some((e) => e.includes('Dockerfile must wire the wordlists')),
    );
  });

  it('fails when IMAGE_WORDLISTS_MAX_MIB is not a positive integer', () => {
    assert.ok(checkWordlistsRepo(REPO_ROOT, { IMAGE_WORDLISTS_MAX_MIB: '0' }).length > 0);
    assert.ok(checkWordlistsRepo(REPO_ROOT, { IMAGE_WORDLISTS_MAX_MIB: '0.5' }).length > 0);
  });
});
