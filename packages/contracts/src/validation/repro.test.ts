import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  parseReproManifest,
  REPRO_BODY_INLINE_MAX_BYTES,
  REPRO_FORMAT_VERSION,
  ReproManifestSchema,
  ReproRequestDescriptorSchema,
} from './repro.js';

const FIXTURE = new URL('./fixtures/repro-bundle-1.0/', import.meta.url);
const DOCS = new URL('../../../../docs/architecture/repro-bundle-format.md', import.meta.url);

function readFixture(path: string): string {
  return readFileSync(new URL(path, FIXTURE), 'utf8');
}

function fixtureManifest(): Record<string, unknown> {
  return JSON.parse(readFixture('manifest.json')) as Record<string, unknown>;
}

function fixtureRequest(): Record<string, unknown> {
  return JSON.parse(readFixture('requests/0001.json')) as Record<string, unknown>;
}

/** The bundle digest rule (docs/architecture/repro-bundle-format.md): sorted `<path> <sha256>` lines, no manifest. */
function bundleDigest(entries: Record<string, string>): string {
  const lines = Object.keys(entries)
    .filter((path) => path !== 'manifest.json')
    .sort()
    .map(
      (path) =>
        `${path} ${createHash('sha256')
          .update(entries[path] ?? '')
          .digest('hex')}\n`,
    );
  return createHash('sha256').update(lines.join('')).digest('hex');
}

describe('ReproManifestSchema', () => {
  it('parses the committed example bundle', () => {
    const manifest = parseReproManifest(fixtureManifest());
    expect(manifest.formatVersion).toBe(REPRO_FORMAT_VERSION);
    expect(manifest.requestCount).toBe(1);
  });

  it('pins the format version to 1.0', () => {
    expect(REPRO_FORMAT_VERSION).toBe('1.0');
  });

  it('rejects an unknown formatVersion (the runner and the verifier refuse it)', () => {
    expect(
      ReproManifestSchema.safeParse({ ...fixtureManifest(), formatVersion: '2.0' }).success,
    ).toBe(false);
    expect(ReproManifestSchema.safeParse({ ...fixtureManifest(), formatVersion: '' }).success).toBe(
      false,
    );
    expect(() => parseReproManifest({ ...fixtureManifest(), formatVersion: '0.9' })).toThrow();
  });

  it('rejects an empty request sequence (requestCount must be at least one)', () => {
    expect(ReproManifestSchema.safeParse({ ...fixtureManifest(), requestCount: 0 }).success).toBe(
      false,
    );
  });

  it('rejects an unknown oracle type, one outside the replay catalogue', () => {
    const manifest = fixtureManifest();
    expect(
      ReproManifestSchema.safeParse({
        ...manifest,
        oracle: { type: 'vibes', params: {} },
      }).success,
    ).toBe(false);
  });

  it('rejects oracle params that do not match the catalogue for the declared type', () => {
    const manifest = fixtureManifest();
    const result = ReproManifestSchema.safeParse({
      ...manifest,
      oracle: { type: 'status_diff', params: { unexpected: true } },
    });
    expect(result.success).toBe(false);
  });

  it('refuses a base URL placeholder other than the fixed one, and an unknown field', () => {
    const manifest = fixtureManifest();
    expect(
      ReproManifestSchema.safeParse({ ...manifest, baseUrlPlaceholder: 'https://a.example' })
        .success,
    ).toBe(false);
    expect(ReproManifestSchema.safeParse({ ...manifest, extra: 1 }).success).toBe(false);
  });

  it('refuses a public id of the wrong prefix', () => {
    const manifest = fixtureManifest();
    expect(
      ReproManifestSchema.safeParse({
        ...manifest,
        findingPublicId: manifest.runPublicId,
      }).success,
    ).toBe(false);
  });

  it('refuses a bundle digest that is not lowercase hex SHA-256', () => {
    expect(
      ReproManifestSchema.safeParse({ ...fixtureManifest(), bundleSha256: 'NOT-HEX' }).success,
    ).toBe(false);
  });

  it('keeps the documented example identical to the committed fixture', () => {
    const doc = readFileSync(DOCS, 'utf8');
    const block = /```json manifest\n([\s\S]*?)\n```/.exec(doc)?.[1];
    expect(block).toBeDefined();
    expect(JSON.parse(block ?? '')).toEqual(fixtureManifest());
  });

  it('documents the bundle digest rule the fixture was built with', () => {
    const entries = {
      'README.md': readFixture('README.md'),
      'expected.json': readFixture('expected.json'),
      'requests/0001.json': readFixture('requests/0001.json'),
    };
    expect(bundleDigest({ ...entries, 'manifest.json': 'ignored' })).toBe(
      parseReproManifest(fixtureManifest()).bundleSha256,
    );
  });
});

describe('ReproRequestDescriptorSchema', () => {
  it('accepts the example request', () => {
    expect(ReproRequestDescriptorSchema.safeParse(fixtureRequest()).success).toBe(true);
  });

  it('rejects a descriptor whose headers carry an authorization value', () => {
    const result = ReproRequestDescriptorSchema.safeParse({
      ...fixtureRequest(),
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    expect(result.success).toBe(false);
  });

  it('refuses cookie and proxy-authorization headers in any letter case, whatever the value', () => {
    for (const name of ['cookie', 'Cookie', 'Proxy-Authorization', 'AUTHORIZATION']) {
      expect(
        ReproRequestDescriptorSchema.safeParse({
          ...fixtureRequest(),
          headers: { [name]: '' },
        }).success,
      ).toBe(false);
    }
  });

  it('refuses a header that is not on the allowlist', () => {
    expect(
      ReproRequestDescriptorSchema.safeParse({
        ...fixtureRequest(),
        headers: { 'x-api-key': 'value' },
      }).success,
    ).toBe(false);
  });

  it('refuses a url with a literal host instead of the base URL placeholder', () => {
    expect(
      ReproRequestDescriptorSchema.safeParse({
        ...fixtureRequest(),
        url: 'https://app.example.test/orders/1001',
      }).success,
    ).toBe(false);
  });

  it('refuses a role that is a token rather than a role placeholder', () => {
    expect(
      ReproRequestDescriptorSchema.safeParse({ ...fixtureRequest(), roleName: 'eyJhbGciOi' })
        .success,
    ).toBe(false);
  });

  it('keeps an inline body within the cap and moves a larger one to an evidence pointer', () => {
    const base = fixtureRequest();
    expect(
      ReproRequestDescriptorSchema.safeParse({
        ...base,
        body: {
          encoding: 'utf8',
          content: 'a'.repeat(REPRO_BODY_INLINE_MAX_BYTES),
          evidenceRef: null,
        },
      }).success,
    ).toBe(true);
    expect(
      ReproRequestDescriptorSchema.safeParse({
        ...base,
        body: {
          encoding: 'utf8',
          content: 'a'.repeat(REPRO_BODY_INLINE_MAX_BYTES + 1),
          evidenceRef: null,
        },
      }).success,
    ).toBe(false);
    expect(
      ReproRequestDescriptorSchema.safeParse({
        ...base,
        body: { encoding: 'utf8', content: null, evidenceRef: 'evidence/body-1' },
      }).success,
    ).toBe(true);
  });

  it('refuses a body that is both inline and a pointer, or neither', () => {
    const base = fixtureRequest();
    expect(
      ReproRequestDescriptorSchema.safeParse({
        ...base,
        body: { encoding: 'utf8', content: 'x', evidenceRef: 'evidence/body-1' },
      }).success,
    ).toBe(false);
    expect(
      ReproRequestDescriptorSchema.safeParse({
        ...base,
        body: { encoding: 'utf8', content: null, evidenceRef: null },
      }).success,
    ).toBe(false);
  });

  it('accepts canonical base64 for binary bodies and refuses malformed base64', () => {
    const base = fixtureRequest();
    expect(
      ReproRequestDescriptorSchema.safeParse({
        ...base,
        body: { encoding: 'base64', content: 'AAEC', evidenceRef: null },
      }).success,
    ).toBe(true);
    expect(
      ReproRequestDescriptorSchema.safeParse({
        ...base,
        body: { encoding: 'base64', content: 'AAE', evidenceRef: null },
      }).success,
    ).toBe(false);
  });

  it('refuses a request index outside the bundle sequence', () => {
    expect(ReproRequestDescriptorSchema.safeParse({ ...fixtureRequest(), index: 0 }).success).toBe(
      false,
    );
  });
});
