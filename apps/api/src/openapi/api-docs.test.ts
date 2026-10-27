import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '@blackwing/errors';

// The hand-written conventions page documents error codes and their statuses. This keeps it in step
// with the error registry, which is the source of truth (a code cannot exist without a status).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const conventions = readFileSync(path.join(repoRoot, 'docs/api/conventions.md'), 'utf8');

/** Rows of the form `| `CODE` | 422 | ... |` from the conventions error table. */
function documentedCodes(markdown: string): { code: string; status: number }[] {
  const rows = [...markdown.matchAll(/^\| `([A-Z_]+)` \| (\d{3}) \|/gm)];
  return rows.map((match) => ({ code: match[1] ?? '', status: Number(match[2]) }));
}

describe('API conventions page', () => {
  const documented = documentedCodes(conventions);

  it('documents a set of error codes', () => {
    expect(documented.length).toBeGreaterThanOrEqual(10);
  });

  it.each(documented.map((entry) => [entry.code, entry.status] as const))(
    '%s is a registered code answering %i',
    (code, status) => {
      expect(Object.hasOwn(ERROR_CODES, code)).toBe(true);
      expect(ERROR_CODES[code as keyof typeof ERROR_CODES].status).toBe(status);
    },
  );

  it('names the idempotency header and the replay header exactly as the API sends them', () => {
    expect(conventions).toContain('`Idempotency-Key`');
    expect(conventions).toContain('`Idempotency-Replayed: true`');
  });

  it('never shows a credential-looking value', () => {
    expect(conventions).not.toMatch(/bw_(pat|ci)_[A-Za-z0-9]{12,}/);
  });
});
