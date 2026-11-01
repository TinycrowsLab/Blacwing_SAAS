import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  parseToolManifest,
  TOOL_MANIFEST_PATH,
  type ToolManifest,
  toolManifestEntrySchema,
  toolManifestSchema,
} from './tool-manifest.js';

const sha = (c: string) => c.repeat(64);

const validManifest = (): ToolManifest => ({
  imageBaseDigest: `sha256:${sha('a')}`,
  imageDigest: null,
  generatedAt: '2026-11-01T00:00:00.000Z',
  tools: [
    {
      name: 'httpx',
      version: '1.12.0',
      sha256: sha('1'),
      licence: 'MIT',
      source: 'https://github.com/projectdiscovery/httpx',
    },
    {
      name: 'nuclei',
      version: '3.11.1',
      sha256: sha('2'),
      licence: 'MIT',
      source: 'https://github.com/projectdiscovery/nuclei',
    },
  ],
  nucleiTemplatesCommit: 'f'.repeat(40),
  playwrightVersion: '1.63.0',
  chromiumRevision: '1243',
});

/** Parses a manifest with one field replaced, expecting it to fail. */
const withField = (patch: Record<string, unknown>) => ({ ...validManifest(), ...patch });

describe('toolManifestSchema', () => {
  it('accepts a complete, sorted manifest', () => {
    expect(parseToolManifest(validManifest())).toEqual(validManifest());
  });

  it('accepts a published image once IMAGE-012 has filled imageDigest', () => {
    expect(() => parseToolManifest(withField({ imageDigest: `sha256:${sha('b')}` }))).not.toThrow();
  });

  it('points at the fixed path the image writes', () => {
    expect(TOOL_MANIFEST_PATH).toBe('/etc/bw/tool-manifest.json');
  });

  it.each([
    ['a missing field', () => ({ ...validManifest(), playwrightVersion: undefined })],
    ['an unknown extra field', () => withField({ extra: true })],
    ['an empty tool list', () => withField({ tools: [] })],
    ['a short base digest', () => withField({ imageBaseDigest: 'sha256:abc' })],
    ['a base digest without the sha256 prefix', () => withField({ imageBaseDigest: sha('a') })],
    ['an uppercase image digest', () => withField({ imageDigest: `sha256:${sha('A')}` })],
    ['a non-ISO generatedAt', () => withField({ generatedAt: '2026-11-01' })],
    [
      'a timestamp with an offset',
      () => withField({ generatedAt: '2026-11-01T00:00:00.000+01:00' }),
    ],
    ['a template commit that is not 40 hex', () => withField({ nucleiTemplatesCommit: 'main' })],
    ['a non-semver playwright version', () => withField({ playwrightVersion: '1.63' })],
    ['a chromium revision with letters', () => withField({ chromiumRevision: '12a3' })],
  ])('rejects %s', (_label, build) => {
    expect(() => parseToolManifest(build())).toThrow(ZodError);
  });

  it('rejects tools that are not sorted by name, and duplicates', () => {
    const base = validManifest();
    const [httpx, nuclei] = base.tools;
    expect(() => toolManifestSchema.parse({ ...base, tools: [nuclei, httpx] })).toThrow(ZodError);
    expect(() => toolManifestSchema.parse({ ...base, tools: [httpx, httpx] })).toThrow(ZodError);
  });
});

describe('toolManifestEntrySchema', () => {
  const entry = {
    name: 'httpx',
    version: '1.12.0',
    sha256: sha('1'),
    licence: 'MIT',
    source: 'https://github.com/projectdiscovery/httpx',
  };

  it('rejects a non-https source, a bad digest and an extra key', () => {
    expect(() =>
      toolManifestEntrySchema.parse({ ...entry, source: 'http://example.test/x' }),
    ).toThrow(ZodError);
    expect(() => toolManifestEntrySchema.parse({ ...entry, sha256: 'zz' })).toThrow(ZodError);
    expect(() => toolManifestEntrySchema.parse({ ...entry, path: '/tmp/x' })).toThrow(ZodError);
  });

  it('rejects a name with path separators or uppercase', () => {
    expect(() => toolManifestEntrySchema.parse({ ...entry, name: '../httpx' })).toThrow(ZodError);
    expect(() => toolManifestEntrySchema.parse({ ...entry, name: 'HTTPX' })).toThrow(ZodError);
  });
});
