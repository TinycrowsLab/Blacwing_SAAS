import { describe, expect, it } from 'vitest';

import { stripMarkdown } from './markdown';

describe('stripMarkdown', () => {
  it('drops heading markers, bold and code delimiters', () => {
    expect(stripMarkdown('## Final summary\n**Target:** `Juice Shop`')).toBe(
      'Final summary Target: Juice Shop',
    );
  });
});
