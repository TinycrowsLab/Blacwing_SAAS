import { describe, expect, it } from 'vitest';

import { sanitiseFilename } from './filename.js';

describe('sanitiseFilename (SCOPE-006, CWE-22)', () => {
  it('keeps a plain, safe name unchanged', () => {
    expect(sanitiseFilename('spec-v2.openapi.json')).toBe('spec-v2.openapi.json');
  });

  it('turns path traversal and separators into a bare name', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitiseFilename('..\\..\\windows\\system.ini')).toBe('windows_system.ini');
    expect(sanitiseFilename('C:\\x\\y.json')).toBe('C_x_y.json');
  });

  it('drops leading dots and underscores so the name cannot hide or traverse', () => {
    expect(sanitiseFilename('.env')).toBe('env');
    expect(sanitiseFilename('___spec.json')).toBe('spec.json');
  });

  it('removes control characters, including NUL and CRLF', () => {
    expect(sanitiseFilename('a\u0000b\r\nc.json')).toBe('abc.json');
    expect(sanitiseFilename('x\u0085y.yaml')).toBe('xy.yaml');
  });

  it('normalises compatibility characters with NFKC', () => {
    expect(sanitiseFilename('ｓｐｅｃ．ｊｓｏｎ')).toBe('spec.json');
  });

  it('keeps unicode letters and replaces emoji and spaces', () => {
    expect(sanitiseFilename('спецификация.json')).toBe('спецификация.json');
    expect(sanitiseFilename('my spec 🚀.yaml')).toBe('my_spec_.yaml');
  });

  it('caps the length in code points', () => {
    const capped = sanitiseFilename(`${'a'.repeat(300)}.json`);
    expect(Array.from(capped)).toHaveLength(100);
  });

  it('falls back to a fixed name when nothing usable remains', () => {
    expect(sanitiseFilename('')).toBe('upload');
    expect(sanitiseFilename('...')).toBe('upload');
    expect(sanitiseFilename('/////')).toBe('upload');
  });
});
