import { describe, expect, it } from 'vitest';

import { markdownToHtml, stripMarkdown } from './markdown';

describe('stripMarkdown', () => {
  it('drops heading markers, bold and code delimiters', () => {
    expect(stripMarkdown('## Final summary\n**Target:** `Juice Shop`')).toBe(
      'Final summary · Target: Juice Shop',
    );
  });
});

describe('markdownToHtml', () => {
  it('renders the same subset and escapes every piece of text', () => {
    expect(markdownToHtml('**Risk:** `a<b>`\n\n- one\n- <script>')).toBe(
      '<p><strong>Risk:</strong> <code>a&lt;b&gt;</code></p>\n<ul><li>one</li><li>&lt;script&gt;</li></ul>',
    );
    expect(markdownToHtml('| a | b |\n|---|---|\n| 1 | "2" |')).toBe(
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>&quot;2&quot;</td></tr></tbody></table>',
    );
  });
});
