import { describe, expect, it } from 'vitest';

import { structuralDifference, structuralTokens } from './structure.js';

describe('structuralTokens', () => {
  it('projects a JSON body to a canonical form that ignores key order and whitespace', () => {
    expect(structuralTokens('{"b": 2, "a": {"d": 1, "c": 0}}')).toEqual(
      structuralTokens('{\n "a": {"c": 0, "d": 1},\n "b": 2\n}'),
    );
  });

  it('keeps the order of nothing and the content of every JSON value', () => {
    expect(structuralDifference('{"a":[1,2]}', '{"a":[2,1]}')).toBe(0);
    expect(structuralDifference('{"a":[1,2]}', '{"a":[1,3]}')).toBeGreaterThan(0);
  });

  it('projects markup to its tag skeleton and words, ignoring whitespace between tags', () => {
    expect(structuralTokens('<p>\n  hello   world\n</p>')).toEqual([
      '<p>',
      '</p>',
      'hello',
      'world',
    ]);
  });

  it('treats a leading byte order mark as no content', () => {
    expect(structuralDifference('\uFEFF<p>a</p>', '<p>a</p>')).toBe(0);
  });

  it('treats text that is not JSON or markup as words', () => {
    expect(structuralTokens('  plain text \n here ')).toEqual(['plain', 'text', 'here']);
  });

  it('counts a token that occurs in only one body, with multiplicity', () => {
    expect(structuralDifference('a a b', 'a b b')).toBe(2);
    expect(structuralDifference('', '')).toBe(0);
  });

  it('yields no tokens for an empty body', () => {
    expect(structuralTokens('')).toEqual([]);
  });
});
