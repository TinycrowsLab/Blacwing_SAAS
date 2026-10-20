import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { name, version } from './index.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

describe('@blackwing/replay', () => {
  it('exports its scoped workspace name', () => {
    expect(name).toBe('@blackwing/replay');
    expect(name).toBe(manifest.name);
  });

  it('exports a version matching package.json', () => {
    expect(version).toBe(manifest.version);
  });
});
