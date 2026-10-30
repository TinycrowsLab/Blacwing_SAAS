import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateInvariantMatrix,
  type FileReader,
  INVARIANT_MATRIX,
  type MatrixEntry,
  renderInvariantReport,
  SECURITY_INVARIANTS,
} from './invariant-matrix.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const repoReader: FileReader = {
  read: (file) => {
    const path = join(REPO_ROOT, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  },
};

/** A reader over fixed contents, so each regression is injected without touching the repository. */
function memoryReader(files: Record<string, string>): FileReader {
  return { read: (file) => files[file] ?? null };
}

const FIXTURE_FILE = 'fixture/owner.test.ts';
const FIXTURE_INVARIANTS = [{ id: 'X.1', title: 'fixture invariant' }] as const;

describe('§8 invariant matrix (repository)', () => {
  const report = evaluateInvariantMatrix(INVARIANT_MATRIX, repoReader);

  it('lists exactly the eleven §8 invariants, in order', () => {
    expect(SECURITY_INVARIANTS.map((inv) => inv.id)).toEqual([
      '8.1',
      '8.2',
      '8.3',
      '8.4',
      '8.5',
      '8.6',
      '8.7',
      '8.8',
      '8.9',
      '8.10',
      '8.11',
    ]);
  });

  it('maps every §8 invariant to at least one owning test', () => {
    expect(report.gaps).toEqual([]);
    for (const inv of report.invariants) {
      expect(inv.refs.length, `invariant ${inv.id} has owning tests`).toBeGreaterThan(0);
    }
  });

  it('resolves every referenced test to a real file that still carries its title', () => {
    expect(report.broken).toEqual([]);
  });

  it('rejects no matrix entry for an unknown invariant', () => {
    expect(report.unknown).toEqual([]);
  });

  it('is green as a whole', () => {
    expect(report.green).toBe(true);
  });

  it('writes the coverage artifact that CI uploads', () => {
    const outDir = join(REPO_ROOT, 'packages/testing/coverage');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'invariant-matrix.json'), renderInvariantReport(report));
    const written = JSON.parse(readFileSync(join(outDir, 'invariant-matrix.json'), 'utf8')) as {
      green: boolean;
      invariants: { id: string; refs: unknown[] }[];
    };
    expect(written.green).toBe(true);
    expect(written.invariants.map((inv) => inv.id)).toHaveLength(SECURITY_INVARIANTS.length);
  });
});

describe('§8 invariant matrix (regression self-test)', () => {
  it('goes red when an invariant loses all of its owning tests (a gap, never a silent pass)', () => {
    const withoutEgress = INVARIANT_MATRIX.filter((entry) => entry.id !== '8.2');
    const report = evaluateInvariantMatrix(withoutEgress, repoReader);
    expect(report.green).toBe(false);
    expect(report.gaps).toEqual(['8.2']);
  });

  it('goes red when an invariant entry lists no tests', () => {
    const emptied: MatrixEntry[] = INVARIANT_MATRIX.map((entry) =>
      entry.id === '8.5' ? { id: '8.5', tests: [] } : entry,
    );
    const report = evaluateInvariantMatrix(emptied, repoReader);
    expect(report.green).toBe(false);
    expect(report.gaps).toContain('8.5');
  });

  it('goes red when a referenced test file is removed', () => {
    const hiddenFile = 'apps/egress-gateway/internal/netguard/guard_test.go';
    const reader: FileReader = {
      read: (file) => (file === hiddenFile ? null : repoReader.read(file)),
    };
    const report = evaluateInvariantMatrix(INVARIANT_MATRIX, reader);
    expect(report.green).toBe(false);
    expect(report.broken.some((b) => b.id === '8.2' && b.status === 'missing_file')).toBe(true);
  });

  it('goes red when a referenced test title is renamed or removed', () => {
    const matrix: MatrixEntry[] = [
      { id: 'X.1', tests: [{ file: FIXTURE_FILE, title: 'renamed away' }] },
    ];
    const report = evaluateInvariantMatrix(
      matrix,
      memoryReader({ [FIXTURE_FILE]: "it('something else entirely', () => {});" }),
      FIXTURE_INVARIANTS,
    );
    expect(report.green).toBe(false);
    expect(report.broken).toEqual([
      { id: 'X.1', ref: { file: FIXTURE_FILE, title: 'renamed away' }, status: 'missing_title' },
    ]);
  });

  it('goes red for a matrix entry whose invariant is not in the §8 list', () => {
    const matrix: MatrixEntry[] = [
      { id: '8.99', tests: [{ file: FIXTURE_FILE, title: 'anything' }] },
    ];
    const report = evaluateInvariantMatrix(matrix, memoryReader({}), FIXTURE_INVARIANTS);
    expect(report.green).toBe(false);
    expect(report.unknown).toEqual(['8.99']);
  });

  it('goes green when the referenced title is present in the file', () => {
    const matrix: MatrixEntry[] = [
      { id: 'X.1', tests: [{ file: FIXTURE_FILE, title: 'owns the fixture' }] },
    ];
    const report = evaluateInvariantMatrix(
      matrix,
      memoryReader({ [FIXTURE_FILE]: "it('owns the fixture', () => {});" }),
      FIXTURE_INVARIANTS,
    );
    expect(report.green).toBe(true);
  });
});
