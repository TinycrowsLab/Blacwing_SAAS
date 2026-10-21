// Self-tests for infra/compose/temporal/bootstrap.sh (DEVENV-007): idempotency, retention, search
// attributes and the not-ready path, against a stub `temporal` CLI that keeps its state in a temp dir.
// Also lints the temporal services of the dev compose file (pinned digests, no container_name).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'infra', 'compose', 'temporal', 'bootstrap.sh');
const COMPOSE = path.join(REPO, 'infra', 'compose', 'docker-compose.dev.yml');

const STUB = `#!/bin/sh
S="$STUB_STATE"
echo "$*" >> "$S/calls"
[ -f "$S/down" ] && exit 1
get() { key="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$key" ]; then echo "$2"; return; fi; shift; done; }
case "$1 $2 $3" in
  "operator cluster health") exit 0 ;;
  "operator namespace describe") [ -f "$S/ns" ] && exit 0 || exit 1 ;;
  "operator namespace create") echo "$*" > "$S/ns"; get --retention "$@" > "$S/retention"; exit 0 ;;
  "operator namespace update") get --retention "$@" > "$S/retention"; exit 0 ;;
  "operator search-attribute list") [ -f "$S/ns" ] || exit 1; echo "Name Type"; cat "$S/attrs" 2>/dev/null; exit 0 ;;
  "operator search-attribute create") echo "$(get --name "$@") $(get --type "$@")" >> "$S/attrs"; exit 0 ;;
esac
exit 2
`;

describe('temporal bootstrap.sh', () => {
  let dir = '';
  let bin = '';
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-temporal-'));
    bin = path.join(dir, 'temporal');
    fs.writeFileSync(bin, STUB, { mode: 0o755 });
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const state = () => fs.mkdtempSync(path.join(dir, 's-'));
  const run = (/** @type {string} */ s, /** @type {Record<string, string>} */ env = {}) =>
    spawnSync('sh', [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        TEMPORAL_BIN: bin,
        STUB_STATE: s,
        BW_TEMPORAL_WAIT_ATTEMPTS: '1',
        ...env,
      },
    });
  const read = (/** @type {string} */ s, /** @type {string} */ f) =>
    fs.readFileSync(path.join(s, f), 'utf8');

  it('creates the namespace with retention and registers all search attributes', () => {
    const s = state();
    const r = run(s, { BW_TEMPORAL_RETENTION: '96h' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(s, 'retention').trim(), '96h');
    assert.deepEqual(read(s, 'attrs').trim().split('\n'), [
      'runId Keyword',
      'tenantId Keyword',
      'assessmentId Keyword',
      'runState Keyword',
    ]);
  });

  it('is idempotent: a re-run creates nothing again', () => {
    const s = state();
    assert.equal(run(s).status, 0);
    const first = read(s, 'attrs');
    const r = run(s);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(s, 'attrs'), first);
    const creates = read(s, 'calls')
      .split('\n')
      .filter((l) => /namespace create|search-attribute create/.test(l));
    assert.equal(creates.length, 5);
    assert.match(r.stdout, /already registered/);
  });

  it('applies a changed retention to an existing namespace', () => {
    const s = state();
    run(s, { BW_TEMPORAL_RETENTION: '72h' });
    assert.equal(run(s, { BW_TEMPORAL_RETENTION: '168h' }).status, 0);
    assert.equal(read(s, 'retention').trim(), '168h');
  });

  it('fails loudly on a type conflict and leaves the registered attribute alone', () => {
    const s = state();
    assert.equal(run(s).status, 0);
    // tenantId was registered as Int by someone else: the run must refuse, not skip or retype it.
    fs.writeFileSync(
      path.join(s, 'attrs'),
      'runId Keyword\ntenantId Int\nassessmentId Keyword\nrunState Keyword\n',
    );
    const before = read(s, 'attrs');
    const r = run(s);
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr,
      /SEARCH_ATTR_TYPE_CONFLICT: search attribute tenantId is Int, expected Keyword/,
    );
    assert.equal(read(s, 'attrs'), before);
    const creates = read(s, 'calls')
      .split('\n')
      .filter((l) => /search-attribute create/.test(l));
    assert.equal(creates.length, 4, 'no attribute was created by the conflicting run');
  });

  it('fails (non-zero) when the server never becomes healthy', () => {
    const s = state();
    fs.writeFileSync(path.join(s, 'down'), '');
    const r = run(s);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not healthy/);
  });
});

describe('docker-compose.dev.yml temporal services', () => {
  const text = fs.readFileSync(COMPOSE, 'utf8');
  it('pins temporal images by digest and avoids container_name', () => {
    const images = [...text.matchAll(/image:\s*(temporalio\/\S+)/g)];
    assert.equal(images.length, 3);
    for (const m of images) assert.match(m[1] ?? '', /@sha256:[0-9a-f]{64}$/);
    assert.doesNotMatch(text, /^\s*container_name:/m);
  });
  it('waits for postgres and for the server', () => {
    assert.match(text, /postgres: \{ condition: service_healthy \}/);
    assert.equal([...text.matchAll(/temporal: \{ condition: service_healthy \}/g)].length, 2);
  });
});
