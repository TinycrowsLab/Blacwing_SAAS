import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DOCS_PATH,
  MANIFEST_PATH,
  applyPlan,
  createGitHubClient,
  loadManifest,
  main,
  parseArgs,
  parseCurrentLabels,
  parseManifest,
  planSync,
  updateDocs,
} from './sync-labels.mjs';
import {
  REPO_ROOT,
  SCRIPTS_DIR,
  asArray,
  asObject,
  cleanEnv,
  parseJsonObject,
} from './test-fixtures.mjs';

const SYNC = path.join(SCRIPTS_DIR, 'sync-labels.mjs');
const TOKEN = 'test-token-value-never-printed';

/** Output sink for streams a test does not inspect. */
const discard = () => undefined;

/**
 * Runs `fn` the way an async API call settles: its result resolves, its throw rejects.
 * @template T
 * @param {() => T} fn
 * @returns {Promise<T>}
 */
function settle(fn) {
  return new Promise((resolve) => {
    resolve(fn());
  });
}

/**
 * A label as the fake GitHub API stores it, parsed from a request body.
 * @param {string} body
 * @param {'name' | 'new_name'} nameKey
 * @returns {{ name: string, color: string, description: string | null }}
 */
function labelFromBody(body, nameKey) {
  const value = asObject(JSON.parse(body), 'request body');
  return {
    name: String(value[nameKey]),
    color: String(value.color),
    description: typeof value.description === 'string' ? value.description : null,
  };
}

/**
 * @param {string} body  YAML for the `labels:` list of a single group
 * @param {string} [groupExtra]
 * @returns {string}
 */
function manifestYaml(body, groupExtra = '') {
  return `version: 1\ngroups:\n  - id: test\n    title: Test\n    description: Test group.\n${groupExtra}    labels:\n${body}`;
}

/**
 * @param {string} text
 * @param {RegExp} pattern
 */
function assertInvalid(text, pattern) {
  const { manifest, errors } = parseManifest(text);
  assert.equal(manifest, null, 'expected the manifest to be rejected');
  assert.ok(
    errors.some((e) => pattern.test(e)),
    `expected an error matching ${pattern}, got:\n${errors.join('\n') || '(none)'}`,
  );
}

/**
 * @param {string} name
 * @param {string} [color]
 * @param {string} [description]
 * @param {string[]} [previously]
 * @returns {import("./sync-labels.mjs").Label}
 */
function label(name, color = 'AABBCC', description = `About ${name}`, previously = []) {
  return { name, color, description, previously, group: 'test' };
}

/**
 * In-memory stand-in for the GitHub label API with GitHub's case-insensitive names.
 * @param {import("./sync-labels.mjs").CurrentLabel[]} initial
 * @param {{ failOn?: string }} [options]
 */
function fakeClient(initial, options = {}) {
  const labels = initial.map((l) => ({ ...l }));
  /** @type {string[]} */
  const calls = [];
  /** @param {string} name */
  const find = (name) => labels.findIndex((l) => l.name.toLowerCase() === name.toLowerCase());
  /** @type {import("./sync-labels.mjs").LabelClient} */
  const client = {
    listLabels: () => settle(() => labels.map((l) => ({ ...l }))),
    createLabel: (l) =>
      settle(() => {
        calls.push(`create ${l.name}`);
        if (options.failOn === l.name) throw new Error('boom');
        if (find(l.name) !== -1) throw new Error(`422 already_exists ${l.name}`);
        labels.push({ ...l });
      }),
    updateLabel: (name, patch) =>
      settle(() => {
        calls.push(`update ${name}`);
        const i = find(name);
        if (i === -1) throw new Error(`404 ${name}`);
        const other = find(patch.new_name);
        if (other !== -1 && other !== i) throw new Error(`422 already_exists ${patch.new_name}`);
        labels[i] = { name: patch.new_name, color: patch.color, description: patch.description };
      }),
    deleteLabel: (name) =>
      settle(() => {
        calls.push(`delete ${name}`);
        const i = find(name);
        if (i === -1) throw new Error(`404 ${name}`);
        labels.splice(i, 1);
      }),
  };
  return { client, labels, calls };
}

describe('the repository label catalogue (.github/labels.yml)', () => {
  const { manifest, errors } = loadManifest(path.join(REPO_ROOT, MANIFEST_PATH));

  it('parses and passes schema validation', () => {
    assert.deepEqual(errors, []);
    assert.ok(manifest !== null);
  });

  /** @param {string} id */
  const names = (id) =>
    (manifest?.groups.find((g) => g.id === id)?.labels ?? []).map((l) => l.name);

  it('defines priority P0..P3, size XS/S/M/L and the functional labels', () => {
    assert.deepEqual(names('priority'), [
      'priority:P0',
      'priority:P1',
      'priority:P2',
      'priority:P3',
    ]);
    assert.deepEqual(names('size'), ['size:XS', 'size:S', 'size:M', 'size:L']);
    assert.deepEqual(names('functional'), ['security', 'gate', 'agent', 'infra']);
    assert.deepEqual(names('type'), ['type:epic', 'type:task', 'type:spike']);
  });

  it('has an epic label for every epic and an area label for every area in EPICS.md', () => {
    const epics = readFileSync(path.join(REPO_ROOT, 'docs/architecture/EPICS.md'), 'utf8');
    const rows = [...epics.matchAll(/^\| `([A-Z0-9]+)` \| [^|]+\| ([^|]+)\|/gm)];
    assert.ok(rows.length >= 60, 'EPICS.md table not found');
    assert.deepEqual(new Set(names('epic')), new Set(rows.map((r) => `epic:${r[1]}`)));
    const areas = new Set(
      rows.map(
        (r) =>
          `area:${(r[2] ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')}`,
      ),
    );
    assert.deepEqual(new Set(names('area')), areas);
  });

  it('has a feature label for every feature in FEATURE_LIST.md', () => {
    const features = readFileSync(
      path.join(REPO_ROOT, 'docs/architecture/FEATURE_LIST.md'),
      'utf8',
    );
    const ids = [...features.matchAll(/^\| (\d+) \|/gm)].map((m) => `F${m[1]}`);
    assert.equal(ids.length, 44);
    assert.deepEqual(names('feature'), ids);
  });

  it('keeps the labels the build workflow relies on', () => {
    for (const name of ['discovered', 'online-porting', 'offline-stub', 'bug', 'v1', 'later']) {
      assert.ok(
        manifest?.labels.some((l) => l.name === name),
        name,
      );
    }
  });

  it('is mirrored by the generated tables in docs/labels.md', () => {
    assert.ok(manifest !== null);
    const docs = readFileSync(path.join(REPO_ROOT, DOCS_PATH), 'utf8');
    assert.equal(
      updateDocs(docs, manifest),
      docs,
      'docs/labels.md is stale: run node scripts/sync-labels.mjs --write-docs',
    );
    for (const l of manifest.labels) assert.ok(docs.includes(`\`${l.name}\``), l.name);
  });
});

describe('label catalogue schema validation', () => {
  it('accepts a minimal valid catalogue and normalises colors to upper case', () => {
    const { manifest, errors } = parseManifest(
      manifestYaml('      - name: a\n        color: "abcdef"\n        description: A.\n'),
    );
    assert.deepEqual(errors, []);
    assert.equal(manifest?.labels[0]?.color, 'ABCDEF');
  });

  it('rejects invalid YAML, duplicate keys and aliases', () => {
    assertInvalid('version: 1\ngroups: [', /invalid YAML/);
    assertInvalid('version: 1\nversion: 1\ngroups: []\n', /invalid YAML/);
    assertInvalid(
      manifestYaml(
        '      - &a\n        name: a\n        color: "AAAAAA"\n        description: A.\n      - *a\n',
      ),
      /aliases are not allowed|invalid YAML/,
    );
  });

  it('rejects a wrong version, missing groups and unknown keys (typos)', () => {
    assertInvalid('version: 2\ngroups: []\n', /"version" must be 1/);
    assertInvalid('version: 1\ngroups: []\n', /`groups` must be a non-empty list/);
    assertInvalid(
      manifestYaml('      - name: a\n        colour: "AAAAAA"\n        description: A.\n'),
      /unknown key "colour"/,
    );
    assertInvalid(
      `${manifestYaml('      - name: a\n        color: "AAAAAA"\n        description: A.\n')}extra: 1\n`,
      /unknown key "extra"/,
    );
  });

  it('rejects duplicate names ignoring case (GitHub label names are case-insensitive)', () => {
    assertInvalid(
      manifestYaml(
        '      - name: Security\n        color: "AAAAAA"\n        description: A.\n' +
          '      - name: security\n        color: "BBBBBB"\n        description: B.\n',
      ),
      /"security" collides with/,
    );
  });

  it('rejects a previous name that collides with another label or is the label itself', () => {
    assertInvalid(
      manifestYaml(
        '      - name: a\n        color: "AAAAAA"\n        description: A.\n' +
          '      - name: b\n        color: "BBBBBB"\n        description: B.\n        previously: ["A"]\n',
      ),
      /"A" collides with/,
    );
    assertInvalid(
      manifestYaml(
        '      - name: a\n        color: "AAAAAA"\n        description: A.\n        previously: ["a"]\n',
      ),
      /lists the label's own name/,
    );
  });

  it('rejects bad colors, including unquoted values YAML reads as numbers', () => {
    assertInvalid(
      manifestYaml('      - name: a\n        color: 000000\n        description: A.\n'),
      /color must be a quoted string/,
    );
    assertInvalid(
      manifestYaml('      - name: a\n        color: "#AAAAAA"\n        description: A.\n'),
      /6 hex digits without "#"/,
    );
    assertInvalid(
      manifestYaml('      - name: a\n        color: "GGGGGG"\n        description: A.\n'),
      /6 hex digits/,
    );
    assertInvalid(
      manifestYaml('      - name: a\n        color: "AAA"\n        description: A.\n'),
      /6 hex digits/,
    );
  });

  it('rejects empty, oversized, comma-containing and padded names', () => {
    assertInvalid(
      manifestYaml('      - name: ""\n        color: "AAAAAA"\n        description: A.\n'),
      /name must not be empty/,
    );
    assertInvalid(
      manifestYaml(
        `      - name: "${'x'.repeat(51)}"\n        color: "AAAAAA"\n        description: A.\n`,
      ),
      /longer than 50/,
    );
    assertInvalid(
      manifestYaml('      - name: "a,b"\n        color: "AAAAAA"\n        description: A.\n'),
      /must not contain a comma/,
    );
    assertInvalid(
      manifestYaml('      - name: " a"\n        color: "AAAAAA"\n        description: A.\n'),
      /leading or trailing whitespace/,
    );
    assertInvalid(
      manifestYaml('      - name: 12\n        color: "AAAAAA"\n        description: A.\n'),
      /name must be a string/,
    );
  });

  it("counts description length in code points (unicode) and enforces GitHub's 100-character limit", () => {
    const ok = parseManifest(
      manifestYaml(
        `      - name: a\n        color: "AAAAAA"\n        description: "${'🔒'.repeat(100)}"\n`,
      ),
    );
    assert.deepEqual(ok.errors, []);
    assertInvalid(
      manifestYaml(
        `      - name: a\n        color: "AAAAAA"\n        description: "${'é'.repeat(101)}"\n`,
      ),
      /101 characters/,
    );
    assertInvalid(
      manifestYaml('      - name: a\n        color: "AAAAAA"\n        description: ""\n'),
      /description must be a non-empty string/,
    );
    assertInvalid(
      manifestYaml('      - name: a\n        color: "AAAAAA"\n'),
      /description must be a non-empty string/,
    );
  });

  it('enforces group prefixes, group ids and non-empty groups', () => {
    assertInvalid(
      manifestYaml(
        '      - name: P0\n        color: "AAAAAA"\n        description: A.\n',
        '    prefix: "priority:"\n',
      ),
      /must start with the group prefix "priority:"/,
    );
    assertInvalid(
      'version: 1\ngroups:\n  - id: Bad_Id\n    title: T\n    description: D.\n    labels: []\n',
      /lowercase kebab-case/,
    );
    assertInvalid(
      'version: 1\ngroups:\n  - id: a\n    title: T\n    description: D.\n    labels: []\n',
      /labels must be a non-empty list/,
    );
    assertInvalid(
      'version: 1\ngroups:\n' +
        '  - id: a\n    title: T\n    description: D.\n    labels:\n      - name: x\n        color: "AAAAAA"\n        description: X.\n' +
        '  - id: a\n    title: T\n    description: D.\n    labels:\n      - name: y\n        color: "AAAAAA"\n        description: Y.\n',
      /duplicate group id "a"/,
    );
  });
});

describe('planSync (diff and idempotency)', () => {
  it('reports unchanged labels, comparing colors case-insensitively and null descriptions as empty', () => {
    const current = parseCurrentLabels(
      [{ name: 'a', color: 'aabbcc', description: 'About a' }],
      'test',
    );
    const plan = planSync([label('a')], current);
    assert.equal(plan.pending, 0);
    assert.equal(plan.counts.unchanged, 1);
    assert.deepEqual(
      parseCurrentLabels([{ name: 'b', color: '#ffffff', description: null }], 't'),
      [{ name: 'b', color: 'ffffff', description: '' }],
    );
  });

  it('plans creates and field updates, listing each changed field', () => {
    const plan = planSync(
      [label('a'), label('b', '112233')],
      [{ name: 'b', color: 'AABBCC', description: 'old' }],
    );
    assert.deepEqual(plan.counts, {
      create: 1,
      update: 1,
      rename: 0,
      delete: 0,
      unchanged: 0,
      extra: 0,
    });
    const update = plan.items.find((i) => i.action === 'update');
    assert.deepEqual(update?.changes, [
      'color: AABBCC -> 112233',
      'description: "old" -> "About b"',
    ]);
  });

  it('treats a case-only difference as an in-place update, never a duplicate create', () => {
    const plan = planSync(
      [label('priority:P0')],
      [{ name: 'Priority:p0', color: 'AABBCC', description: 'About priority:P0' }],
    );
    assert.equal(plan.counts.create, 0);
    assert.equal(plan.items[0]?.action, 'update');
    assert.deepEqual(plan.items[0].changes, ['name: "Priority:p0" -> "priority:P0"']);
  });

  it('renames a label found under a previous name instead of creating a new one', () => {
    const plan = planSync(
      [label('area:console', 'AABBCC', 'About area:console', ['area:ui'])],
      [{ name: 'area:ui', color: 'AABBCC', description: 'About area:console' }],
    );
    assert.deepEqual(plan.counts, {
      create: 0,
      update: 0,
      rename: 1,
      delete: 0,
      unchanged: 0,
      extra: 0,
    });
    assert.equal(plan.items[0]?.current?.name, 'area:ui');
  });

  it('warns and keeps the old label when both the new and a previous name exist (rename collision)', () => {
    const plan = planSync(
      [label('new', 'AABBCC', 'About new', ['old'])],
      [
        { name: 'new', color: 'AABBCC', description: 'About new' },
        { name: 'old', color: 'AABBCC', description: 'x' },
      ],
    );
    assert.equal(plan.counts.unchanged, 1);
    assert.equal(plan.counts.extra, 1);
    assert.equal(plan.counts.delete, 0);
    assert.match(plan.warnings.join('\n'), /"old" \(a previous name of "new"\) still exists/);
  });

  it('keeps labels missing from the catalogue unless --prune is given', () => {
    const current = [{ name: 'stray', color: '000000', description: '' }];
    assert.equal(planSync([], current).counts.extra, 1);
    assert.equal(planSync([], current).pending, 0);
    const pruned = planSync([], current, { prune: true });
    assert.equal(pruned.counts.delete, 1);
    assert.equal(pruned.pending, 1);
  });

  it('reports duplicate current labels instead of failing', () => {
    const plan = planSync(
      [label('a')],
      [
        { name: 'a', color: 'AABBCC', description: 'About a' },
        { name: 'A', color: 'AABBCC', description: 'About a' },
      ],
    );
    assert.match(plan.warnings.join('\n'), /twice/);
    assert.equal(plan.counts.unchanged, 1);
  });

  it('is idempotent: applying the plan leaves nothing to change, and a second apply makes no calls', async () => {
    const desired = [
      label('a'),
      label('b', '112233'),
      label('c', 'AABBCC', 'About c', ['legacy-c']),
      label('D'),
    ];
    const fake = fakeClient([
      { name: 'b', color: 'AABBCC', description: 'old' },
      { name: 'legacy-c', color: '000000', description: '' },
      { name: 'd', color: 'AABBCC', description: 'About D' },
      { name: 'stray', color: '000000', description: '' },
    ]);
    const first = await applyPlan(planSync(desired, await fake.client.listLabels()), fake.client);
    assert.equal(first.failed, null);
    assert.deepEqual(fake.calls.sort(), ['create a', 'update b', 'update d', 'update legacy-c']);
    const again = planSync(desired, await fake.client.listLabels());
    assert.equal(again.pending, 0);
    fake.calls.length = 0;
    await applyPlan(again, fake.client);
    assert.deepEqual(fake.calls, []);
    assert.ok(
      fake.labels.some((l) => l.name === 'stray'),
      'unknown labels are kept without --prune',
    );
  });

  it('stops at the first failed call, reports what was applied, and a re-run continues', async () => {
    const desired = [label('a'), label('b'), label('c')];
    const fake = fakeClient([], { failOn: 'b' });
    const result = await applyPlan(planSync(desired, []), fake.client);
    assert.deepEqual(result.applied, [{ action: 'create', name: 'a' }]);
    assert.equal(result.failed?.name, 'b');
    const healthy = fakeClient(await fake.client.listLabels());
    const rerun = planSync(desired, await healthy.client.listLabels());
    assert.equal(rerun.counts.create, 2);
    assert.equal((await applyPlan(rerun, healthy.client)).failed, null);
    assert.equal(planSync(desired, await healthy.client.listLabels()).pending, 0);
  });
});

describe('parseArgs', () => {
  it('rejects unknown flags, missing values and conflicting sources', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
    assert.throws(() => parseArgs(['--current']), /--current requires a value/);
    assert.throws(() => parseArgs(['--repo', '--dry-run']), /--repo requires a value/);
    assert.throws(
      () => parseArgs(['--current', 'a.json', '--repo', 'o/r']),
      /either --current or --repo/,
    );
    assert.throws(
      () => parseArgs(['--write-docs', '--check-docs']),
      /either --write-docs or --check-docs/,
    );
  });
});

describe('sync-labels CLI (offline)', () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bw-labels-'));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('--dry-run validates and lists the full catalogue (every label) and exits 0', () => {
    const { manifest } = loadManifest(path.join(REPO_ROOT, MANIFEST_PATH));
    assert.ok(manifest !== null);
    const run = spawnSync(process.execPath, [SYNC, '--dry-run'], {
      encoding: 'utf8',
      env: cleanEnv(),
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(
      run.stdout,
      new RegExp(
        `${manifest.labels.length} labels in ${manifest.groups.length} groups \\(valid\\)`,
      ),
    );
    for (const l of manifest.labels)
      assert.ok(run.stdout.includes(`  ${l.name} `), `missing ${l.name}`);
    assert.match(run.stdout, /nothing compared/);
  });

  it('--dry-run --json reports every label and no plan', async () => {
    /** @type {string[]} */
    const out = [];
    const code = await main(['--dry-run', '--json'], {
      stdout: (t) => void out.push(t),
      stderr: discard,
      env: {},
    });
    assert.equal(code, 0);
    const report = parseJsonObject(out.join(''));
    const { manifest } = loadManifest(path.join(REPO_ROOT, MANIFEST_PATH));
    assert.equal(asArray(report.labels).length, manifest?.labels.length);
    assert.equal(report.plan, null);
    assert.equal(report.mode, 'dry-run');
  });

  it('--current diffs against a gh label list snapshot; --fail-on-diff turns drift into exit 1', async () => {
    const snapshot = path.join(dir, 'labels.json');
    writeFileSync(
      snapshot,
      JSON.stringify([
        { name: 'security', color: 'B60205', description: 'security' },
        { name: 'stray', color: '000000', description: '' },
      ]),
    );
    /** @type {string[]} */
    const out = [];
    const io = { stdout: (/** @type {string} */ t) => void out.push(t), stderr: discard, env: {} };
    assert.equal(await main(['--dry-run', '--current', snapshot], io), 0);
    const text = out.join('');
    assert.match(text, /to create, 1 to update, 0 to rename, 0 to delete, 0 unchanged, 1 extra/);
    assert.match(text, /update {2}security\n {10}description: "security" -> /);
    assert.match(text, /extra {3}stray/);
    assert.equal(await main(['--dry-run', '--current', snapshot, '--fail-on-diff'], io), 1);
  });

  it('rejects an invalid catalogue and a malformed snapshot with exit 1, and bad usage with exit 2', async () => {
    const bad = path.join(dir, 'bad.yml');
    writeFileSync(
      bad,
      manifestYaml('      - name: a\n        color: 000000\n        description: A.\n'),
    );
    /** @type {string[]} */
    const err = [];
    const io = { stdout: discard, stderr: (/** @type {string} */ t) => void err.push(t), env: {} };
    assert.equal(await main(['--dry-run', '--manifest', bad], io), 1);
    assert.match(err.join(''), /bad\.yml is invalid/);
    const snapshot = path.join(dir, 'malformed.json');
    writeFileSync(snapshot, JSON.stringify({ not: 'an array' }));
    assert.equal(await main(['--dry-run', '--current', snapshot], io), 1);
    assert.equal(await main(['--bogus'], io), 2);
  });

  it('--check-docs fails on stale docs and --write-docs repairs them', async () => {
    const root = path.join(dir, 'repo');
    mkdirSync(path.join(root, '.github'), { recursive: true });
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(
      path.join(root, MANIFEST_PATH),
      readFileSync(path.join(REPO_ROOT, MANIFEST_PATH)),
    );
    writeFileSync(
      path.join(root, DOCS_PATH),
      '# Labels\n\n<!-- BEGIN GENERATED LABEL CATALOGUE: node scripts/sync-labels.mjs --write-docs -->\nstale\n<!-- END GENERATED LABEL CATALOGUE -->\n',
    );
    const io = { stdout: discard, stderr: discard, env: {} };
    assert.equal(await main(['--check-docs', '--root', root], io), 1);
    assert.equal(await main(['--write-docs', '--root', root], io), 0);
    assert.equal(await main(['--check-docs', '--root', root], io), 0);
    writeFileSync(path.join(root, DOCS_PATH), '# Labels without markers\n');
    assert.equal(await main(['--check-docs', '--root', root], io), 1);
  });
});

describe('GitHub REST client against a local fake API (no internet)', () => {
  /** @type {import("node:http").Server} */
  let server;
  /** @type {string} */
  let apiUrl;
  /** @type {Array<{ method: string, url: string, auth: string | undefined, body: string }>} */
  const requests = [];
  /** @type {Array<{ name: string, color: string, description: string | null }>} */
  let store = [];

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        requests.push({
          method: req.method ?? '',
          url: url.pathname + url.search,
          auth: req.headers.authorization,
          body,
        });
        /**
         * @param {number} status
         * @param {unknown} [payload]
         */
        const send = (status, payload) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(payload === undefined ? '' : JSON.stringify(payload));
        };
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          send(401, { message: 'Bad credentials' });
          return;
        }
        const base = '/repos/acme/demo/labels';
        /** @param {string} name */
        const find = (name) => store.findIndex((l) => l.name.toLowerCase() === name.toLowerCase());
        if (req.method === 'GET' && url.pathname === base) {
          const page = Number(url.searchParams.get('page') ?? '1');
          const per = Number(url.searchParams.get('per_page') ?? '30');
          send(200, store.slice((page - 1) * per, page * per));
          return;
        }
        if (req.method === 'POST' && url.pathname === base) {
          const label = labelFromBody(body, 'name');
          if (find(label.name) !== -1) {
            send(422, { message: 'Validation Failed' });
            return;
          }
          store.push(label);
          send(201, label);
          return;
        }
        if (url.pathname.startsWith(`${base}/`)) {
          const name = decodeURIComponent(url.pathname.slice(base.length + 1));
          const i = find(name);
          if (i === -1) {
            send(404, { message: 'Not Found' });
            return;
          }
          if (req.method === 'PATCH') {
            store[i] = labelFromBody(body, 'new_name');
            send(200, store[i]);
            return;
          }
          if (req.method === 'DELETE') {
            store.splice(i, 1);
            send(204);
            return;
          }
        }
        send(404, { message: 'Not Found' });
      });
    });
    await new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        resolve(undefined);
      }),
    );
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    apiUrl = `http://127.0.0.1:${address.port}`;
  });
  after(
    () =>
      new Promise((resolve) =>
        server.close(() => {
          resolve(undefined);
        }),
      ),
  );

  it('paginates the label list and URL-encodes label names in paths', async () => {
    store = Array.from({ length: 150 }, (_, i) => ({
      name: `l${i}`,
      color: 'AAAAAA',
      description: null,
    }));
    store.push({ name: 'good first issue', color: '7057FF', description: 'Good for newcomers' });
    const client = createGitHubClient({ repo: 'acme/demo', token: TOKEN, apiUrl });
    requests.length = 0;
    const labels = await client.listLabels();
    assert.equal(labels.length, 151);
    assert.deepEqual(
      requests.map((r) => r.url),
      [
        '/repos/acme/demo/labels?per_page=100&page=1',
        '/repos/acme/demo/labels?per_page=100&page=2',
      ],
    );
    await client.updateLabel('good first issue', {
      new_name: 'good first issue',
      color: '7057FF',
      description: 'x',
    });
    assert.equal(requests.at(-1)?.url, '/repos/acme/demo/labels/good%20first%20issue');
    await client.deleteLabel('good first issue');
    assert.equal(requests.at(-1)?.method, 'DELETE');
  });

  it('validates the repo and token and never puts the token in errors', async () => {
    assert.throws(
      () => createGitHubClient({ repo: 'not a repo', token: TOKEN, apiUrl }),
      /owner\/name/,
    );
    assert.throws(
      () => createGitHubClient({ repo: 'acme/demo', token: '', apiUrl }),
      /token is required/,
    );
    const wrong = createGitHubClient({ repo: 'acme/demo', token: 'wrong-token', apiUrl });
    await assert.rejects(wrong.listLabels(), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /401 Bad credentials/);
      assert.ok(!error.message.includes('wrong-token'));
      return true;
    });
  });

  it('main --repo applies the catalogue, verifies it, and a second run changes nothing', async () => {
    store = [
      { name: 'security', color: 'B60205', description: 'security' },
      { name: 'Bug', color: 'd73a4a', description: "Something isn't working" },
      { name: 'stray', color: '000000', description: null },
    ];
    /** @type {string[]} */
    const out = [];
    /** @type {string[]} */
    const err = [];
    const io = {
      stdout: (/** @type {string} */ t) => void out.push(t),
      stderr: (/** @type {string} */ t) => void err.push(t),
      env: { GITHUB_TOKEN: TOKEN, GITHUB_API_URL: apiUrl },
    };
    requests.length = 0;
    assert.equal(await main(['--repo', 'acme/demo', '--dry-run'], io), 0, err.join(''));
    assert.ok(
      requests.every((r) => r.method === 'GET'),
      'a dry run must only read',
    );

    assert.equal(await main(['--repo', 'acme/demo'], io), 0, err.join(''));
    const { manifest } = loadManifest(path.join(REPO_ROOT, MANIFEST_PATH));
    assert.equal(
      store.length,
      (manifest?.labels.length ?? 0) + 1,
      'catalogue applied, stray label kept',
    );
    assert.ok(
      store.some((l) => l.name === 'bug'),
      'case-only difference renamed in place',
    );
    assert.match(out.join(''), /Verification: repository labels match the catalogue/);

    out.length = 0;
    requests.length = 0;
    assert.equal(await main(['--repo', 'acme/demo'], io), 0, err.join(''));
    assert.match(out.join(''), /nothing to change/);
    assert.ok(
      requests.every((r) => r.method === 'GET'),
      'second run must not write',
    );
    assert.ok(requests.every((r) => r.auth === `Bearer ${TOKEN}`));
    assert.ok(
      !out.join('').includes(TOKEN) && !err.join('').includes(TOKEN),
      'token must never be printed',
    );

    assert.equal(await main(['--repo', 'acme/demo', '--prune'], io), 0, err.join(''));
    assert.ok(
      !store.some((l) => l.name === 'stray'),
      '--prune deletes labels outside the catalogue',
    );
  });

  it('main --repo without a token fails with exit 1 before any request', async () => {
    /** @type {string[]} */
    const err = [];
    requests.length = 0;
    const code = await main(['--repo', 'acme/demo'], {
      stdout: discard,
      stderr: (t) => void err.push(t),
      env: { GITHUB_API_URL: apiUrl },
    });
    assert.equal(code, 1);
    assert.match(err.join(''), /token is required/);
    assert.equal(requests.length, 0);
  });

  it('main --repo reports a failed write with exit 1 and what to do next', async () => {
    store = [];
    const failing = /** @type {typeof fetch} */ (
      async (input, init) => {
        if (init?.method === 'POST')
          return new Response(JSON.stringify({ message: 'Server Error' }), { status: 500 });
        return fetch(input, init);
      }
    );
    /** @type {string[]} */
    const err = [];
    const code = await main(['--repo', 'acme/demo'], {
      stdout: discard,
      stderr: (t) => void err.push(t),
      env: { GITHUB_TOKEN: TOKEN, GITHUB_API_URL: apiUrl },
      fetchImpl: failing,
    });
    assert.equal(code, 1);
    assert.match(
      err.join(''),
      /create ".+" failed: GitHub API POST \/repos\/acme\/demo\/labels failed: 500 Server Error \(re-run to continue/,
    );
  });
});
