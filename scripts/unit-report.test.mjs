import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { hasObsoleteSnapshots, vitestArgs } from './ci-unit.mjs';
import {
  buildReport,
  checkCoverage,
  floorsFor,
  parseJunit,
  parseThresholds,
} from './unit-report.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const FLOORS = { lines: 80, statements: 80, functions: 80, branches: 75 };

/** @param {number} pct @param {number} [total] */
const metric = (pct, total = 10) => ({ total, covered: Math.round(total * (pct / 100)), pct });
/** @param {number} pct */
const summaryAt = (pct) => ({
  total: {
    lines: metric(pct),
    statements: metric(pct),
    functions: metric(pct),
    branches: metric(pct),
  },
});

const tmp = mkdtempSync(path.join(tmpdir(), 'unit-report-'));
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Builds a throwaway workspace with one package.
 * @param {string} name
 * @param {{ pct: number, skipped?: number, failures?: number, junit?: boolean, summary?: boolean }} options
 */
function fixture(name, options) {
  const root = mkdtempSync(path.join(tmp, 'ws-'));
  const dir = path.join(root, 'packages', 'pkg');
  mkdirSync(path.join(dir, 'coverage'), { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, scripts: { test: 'vitest run' } }),
  );
  writeFileSync(
    path.join(root, 'coverage-thresholds.json'),
    JSON.stringify({ default: FLOORS, packages: {} }),
  );
  if (options.summary !== false) {
    writeFileSync(
      path.join(dir, 'coverage', 'coverage-summary.json'),
      JSON.stringify(summaryAt(options.pct)),
    );
  }
  if (options.junit !== false) {
    writeFileSync(
      path.join(dir, 'coverage', 'junit.xml'),
      `<?xml version="1.0"?><testsuites name="vitest tests" tests="5" failures="${String(options.failures ?? 0)}" errors="0" time="1" skipped="${String(options.skipped ?? 0)}"></testsuites>`,
    );
  }
  return root;
}

describe('parseThresholds', () => {
  it('accepts the committed file', () => {
    const raw = /** @type {unknown} */ (
      JSON.parse(readFileSync(path.join(repo, 'coverage-thresholds.json'), 'utf8'))
    );
    assert.deepEqual(parseThresholds(raw).errors, []);
  });

  it('rejects malformed floors', () => {
    assert.ok(parseThresholds(null).errors.length > 0);
    const bad = { default: { ...FLOORS, lines: 101 }, packages: { x: { nope: 1 } } };
    const text = parseThresholds(bad).errors.join('\n');
    assert.match(text, /default\.lines/);
    assert.match(text, /unknown metric "nope"/);
    assert.match(parseThresholds({ default: { lines: 1 }, packages: {} }).errors.join(), /missing/);
  });

  it('lets a package override single metrics of the default', () => {
    const { thresholds } = parseThresholds({ default: FLOORS, packages: { a: { lines: 10 } } });
    assert.ok(thresholds);
    assert.deepEqual(floorsFor(thresholds, 'a'), { ...FLOORS, lines: 10 });
    assert.deepEqual(floorsFor(thresholds, 'b'), FLOORS);
  });
});

describe('checkCoverage', () => {
  it('passes at or above the floor', () => {
    assert.deepEqual(checkCoverage('p', summaryAt(80), FLOORS).errors, []);
  });

  // Acceptance: coverage below the threshold fails the job.
  it('fails below the floor and names the metric', () => {
    const { errors } = checkCoverage('p', summaryAt(70), FLOORS);
    assert.equal(errors.length, 4); // lines, statements, functions and branches
    assert.match(errors.join('\n'), /p: lines coverage 70% is below the floor of 80%/);
  });

  it('cannot regress a metric with nothing to cover', () => {
    const empty = {
      total: { ...summaryAt(100).total, branches: { total: 0, covered: 0, pct: 'Unknown' } },
    };
    assert.deepEqual(checkCoverage('p', empty, FLOORS).errors, []);
  });

  it('fails on an unreadable summary', () => {
    assert.match(checkCoverage('p', {}, FLOORS).errors.join(), /no "total"/);
    const broken = { total: { ...summaryAt(100).total, lines: { total: 3, pct: 'Unknown' } } };
    assert.match(checkCoverage('p', broken, FLOORS).errors.join(), /lines is unreadable/);
  });
});

describe('parseJunit', () => {
  it('reads totals from the Vitest report', () => {
    const xml = '<testsuites name="vitest tests" tests="9" failures="1" errors="2" skipped="3">';
    assert.deepEqual(parseJunit(xml), { tests: 9, failures: 3, skipped: 3 });
  });

  it('returns null for something that is not a report', () => {
    assert.equal(parseJunit('<html>'), null);
  });
});

describe('buildReport', () => {
  it('passes a healthy package and summarises counts and coverage', () => {
    const { errors, summary } = buildReport(fixture('@blackwing/ok', { pct: 90 }));
    assert.deepEqual(errors, []);
    assert.match(summary, /Unit tests: passed/);
    assert.match(summary, /5 tests, 0 failed, 0 skipped/);
    assert.match(summary, /\| @blackwing\/ok \| 5 \| 0 \| 90% \|/);
  });

  it('fails when coverage drops below the floor', () => {
    const { errors, summary } = buildReport(fixture('@blackwing/low', { pct: 50 }));
    assert.match(errors.join(), /below the floor/);
    assert.match(summary, /FAILED/);
  });

  // Edge case: a skipped test in the report is never silent.
  it('fails on skipped tests', () => {
    assert.match(
      buildReport(fixture('@blackwing/skip', { pct: 90, skipped: 2 })).errors.join(),
      /2 skipped test/,
    );
  });

  it('fails on failing tests', () => {
    assert.match(
      buildReport(fixture('@blackwing/red', { pct: 90, failures: 1 })).errors.join(),
      /1 failing test/,
    );
  });

  it('fails when a package emitted no reports', () => {
    const text = buildReport(
      fixture('@blackwing/none', { pct: 90, junit: false, summary: false }),
    ).errors.join('\n');
    assert.match(text, /no coverage\/junit\.xml/);
    assert.match(text, /no coverage\/coverage-summary\.json/);
  });

  it('fails when the thresholds file is missing', () => {
    const root = fixture('@blackwing/x', { pct: 90 });
    rmSync(path.join(root, 'coverage-thresholds.json'));
    assert.match(buildReport(root).errors.join(), /coverage-thresholds\.json/);
  });
});

describe('ci-unit', () => {
  // Edge case: snapshot drift fails; Vitest only reports obsolete snapshots.
  it('detects obsolete snapshots in the output', () => {
    assert.equal(hasObsoleteSnapshots('Snapshots  1 obsolete\n'), true);
    assert.equal(hasObsoleteSnapshots(' 1 snapshot file obsolete\n'), true);
    assert.equal(hasObsoleteSnapshots('Tests  5 passed\n'), false);
    assert.equal(hasObsoleteSnapshots('obsolete dependency\n'), false);
    assert.equal(hasObsoleteSnapshots('ok 1 - detects obsolete snapshots in the output\n'), false);
    assert.equal(
      hasObsoleteSnapshots(
        'pkg:test: \u001b[2mSnapshots\u001b[22m \u001b[33m2 obsolete\u001b[39m\n',
      ),
      true,
    );
  });

  it('asks Vitest for v8 coverage, a JSON summary and JUnit in every member', () => {
    const args = vitestArgs();
    assert.ok(args.includes('--coverage.provider=v8'));
    assert.ok(args.includes('--coverage.reporter=json-summary'));
    assert.ok(args.includes('--outputFile.junit=coverage/junit.xml'));
    assert.ok(args.includes('--reporter=junit'));
  });
});

describe('.github/workflows/test.yml', () => {
  /** @typedef {{ run?: string, uses?: string, if?: string, with?: { path?: string } }} Step */
  /** @type {unknown} */
  const parsed = parse(readFileSync(path.join(repo, '.github/workflows/test.yml'), 'utf8'));
  const workflow =
    /** @type {{ on: Record<string, unknown>, permissions: unknown, jobs: { unit: { env: Record<string, string>, steps: Step[] } } }} */ (
      parsed
    );

  it('runs on pull requests with read-only contents and no secrets', () => {
    assert.ok('pull_request' in workflow.on);
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.doesNotMatch(
      readFileSync(path.join(repo, '.github/workflows/test.yml'), 'utf8'),
      /secrets\./,
    );
  });

  it('runs pnpm test:ci deterministically and uploads the reports even on failure', () => {
    const job = workflow.jobs.unit;
    assert.equal(job.env.TZ, 'UTC');
    assert.match(job.env.BW_FC_SEED ?? '', /^\d+$/);
    const steps = job.steps;
    assert.ok(steps.some((s) => s.run === 'pnpm test:ci'));
    const upload = steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    assert.ok(upload);
    assert.match(upload.if ?? '', /!cancelled\(\)/);
    assert.match(upload.with?.path ?? '', /coverage/);
  });
});
