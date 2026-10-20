import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as ids from './index.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

describe('@blackwing/ids', () => {
  it('exports its scoped workspace name', () => {
    expect(ids.name).toBe('@blackwing/ids');
    expect(ids.name).toBe(manifest.name);
  });

  it('exports a version matching package.json', () => {
    expect(ids.version).toBe(manifest.version);
  });

  it('exposes the public API from the entry point', () => {
    for (const fn of [
      'newId',
      'newPublicId',
      'parsePublicId',
      'toUuid',
      'toPublicId',
      'isPublicId',
      'parseUuid',
    ] as const) {
      expect(typeof ids[fn]).toBe('function');
    }
    const id = ids.RunId.generate();
    expect(ids.toPublicId(ids.toUuid(id), 'run')).toBe(id);
  });

  it('does not expose test hooks from the entry point', () => {
    expect(Object.keys(ids)).not.toContain('createUuidV7GeneratorWithCounterLimit');
    expect(Object.keys(ids)).not.toContain('UUIDV7_COUNTER');
  });
});
