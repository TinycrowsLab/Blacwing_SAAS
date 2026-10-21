import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (name: string): string =>
  readFileSync(
    new URL(`../../../infra/compose/openbao/policies/${name}.hcl`, import.meta.url),
    'utf8',
  );

/** Minimal HCL reader for `path "x" { capabilities = [...] }` blocks. */
function parse(hcl: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of hcl.matchAll(/path\s+"([^"]+)"\s*\{\s*capabilities\s*=\s*\[([^\]]*)\]/g)) {
    out.set(
      m[1] ?? '',
      [...(m[2] ?? '').matchAll(/"([a-z]+)"/g)].map((c) => c[1] ?? ''),
    );
  }
  return out;
}

describe('bw-kek-app policy', () => {
  const rules = parse(read('bw-kek-app'));

  it('grants exactly encrypt, decrypt, rewrap and rotate on tenant-* keys', () => {
    expect([...rules.keys()].filter((p) => p.startsWith('transit/')).sort()).toEqual([
      'transit/decrypt/tenant-*',
      'transit/encrypt/tenant-*',
      'transit/keys/tenant-*/rotate',
      'transit/rewrap/tenant-*',
    ]);
    const transitCaps = [...rules]
      .filter(([path]) => path.startsWith('transit/'))
      .map(([, c]) => c);
    expect(transitCaps.every((caps) => caps.length === 1 && caps[0] === 'update')).toBe(true);
  });

  it('cannot export, back up, read, configure or delete key material', () => {
    const code = read('bw-kek-app').replace(/^#.*$/gm, '');
    for (const forbidden of ['export', 'backup', 'datakey', 'delete', 'sudo', '/config']) {
      expect(code.includes(forbidden), forbidden).toBe(false);
    }
    expect(rules.get('transit/keys/tenant-*')).toBeUndefined();
    // the only readable path is the KV lifecycle marker, never a Transit key
    const readable = [...rules].filter(([, caps]) => caps.includes('read')).map(([path]) => path);
    expect(readable).toEqual(['secret/data/platform/kek-state/*']);
  });
});

describe('bw-kek-provisioner policy', () => {
  const text = read('bw-kek-provisioner');
  const rules = parse(text);

  it('creates and configures tenant keys but never exports, backs up, deletes or uses them', () => {
    expect(rules.get('transit/keys/tenant-*')).toEqual(['create', 'update', 'read']);
    expect(rules.get('transit/keys/tenant-*/config')).toEqual(['update']);
    const code = text.replace(/^#.*$/gm, '');
    for (const forbidden of [
      'export',
      'backup',
      'datakey',
      'delete',
      'sudo',
      'encrypt/',
      'decrypt/',
    ]) {
      expect(code.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('only touches the kek-state KV path outside transit', () => {
    const others = [...rules.keys()].filter((p) => !p.startsWith('transit/keys/tenant-'));
    expect(others).toEqual(['secret/data/platform/kek-state/*']);
  });
});
