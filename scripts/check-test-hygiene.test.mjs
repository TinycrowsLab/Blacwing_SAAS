import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkTestFile, checkTree } from './check-test-hygiene.mjs';

// The offending tokens are assembled so this file does not trip its own guard.
const ONLY = '.' + 'only';
const SKIP = '.' + 'skip';

describe('checkTestFile', () => {
  it('accepts a clean file', () => {
    assert.deepEqual(checkTestFile('a.test.ts', "it('works', () => {});\n"), []);
  });

  // Acceptance: a test.only left in the tree fails CI.
  it('rejects test/it/describe .only, fit and fdescribe', () => {
    for (const line of [
      `test${ONLY}('x', () => {});`,
      `  it${ONLY}('x', () => {});`,
      `describe${ONLY}('x', () => {});`,
      `it.concurrent${ONLY}('x', () => {});`,
      "fit('x', () => {});",
      "fdescribe('x', () => {});",
    ]) {
      assert.equal(checkTestFile('a.test.ts', line).length, 1, line);
    }
  });

  it('rejects skipped and todo tests without a linked issue', () => {
    for (const line of [
      `it${SKIP}('x', () => {});`,
      `describe${SKIP}('x', () => {});`,
      "xit('x', () => {});",
      "xdescribe('x', () => {});",
      "it.todo('x');",
    ]) {
      assert.match(checkTestFile('a.test.ts', line).join(), /linked issue/, line);
    }
  });

  it('allows a skip that links an issue on the same or the previous line', () => {
    assert.deepEqual(checkTestFile('a.test.ts', `it${SKIP}('x', () => {}); // blocked by #99`), []);
    assert.deepEqual(
      checkTestFile('a.test.ts', `// tracked in #99\nit${SKIP}('x', () => {});`),
      [],
    );
  });

  it('does not allow .only even with an issue link', () => {
    assert.equal(checkTestFile('a.test.ts', `it${ONLY}('x', () => {}); // #1`).length, 1);
  });

  it('reports file:line and ignores prose in comments', () => {
    const text = `// never use it${SKIP}\n * test${ONLY}\nit${ONLY}('x', () => {});`;
    const errors = checkTestFile('pkg/a.test.ts', text);
    assert.equal(errors.length, 1);
    assert.match(errors[0] ?? '', /^pkg\/a\.test\.ts:3:/);
  });
});

describe('checkTree (real repository)', () => {
  it('is clean', () => {
    assert.deepEqual(checkTree(fileURLToPath(new URL('..', import.meta.url))), []);
  });
});
