// Nothing hard-coded (experience spec §12): no seeded tenant, person, lab target or "demo" in what the console shows.
// Scans the source under src/app and src/components with comments removed; tests are not shipped and are skipped.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd(), 'src');
const FORBIDDEN = /Acme|acme\.test|Avery|Juice Shop|127\.0\.0\.1:3001|18998|\bdemo\b/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Removes block and line comments (a `//` preceded by `:` is a URL, not a comment). */
const withoutComments = (code: string): string =>
  code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

describe('no literals in the console', () => {
  it('ships no seeded names, lab targets or the word demo', () => {
    const hits = ['app', 'components']
      .flatMap((d) => sources(join(ROOT, d)))
      .flatMap((file) =>
        withoutComments(readFileSync(file, 'utf8'))
          .split('\n')
          .flatMap((line, i) => (FORBIDDEN.test(line) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`] : [])),
      );
    expect(hits).toEqual([]);
  });

  it('the scanner sees through comments only', () => {
    expect(withoutComments("const a = 'x'; // demo")).toBe("const a = 'x';");
    expect(withoutComments("fetch('http://demo.test')")).toContain('demo');
  });
});
