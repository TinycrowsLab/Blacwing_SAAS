import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SbxSourceSymlinkEscapeError } from './errors.js';
import {
  assertNoEscapingSymlinks,
  forceRemove,
  makeReadOnly,
  treeBytes,
  walkTree,
} from './tree.js';

describe('tree utilities', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bw-tree-'));
  });
  afterEach(async () => {
    await forceRemove(root);
    await rm(root, { recursive: true, force: true });
  });

  it('sums regular file bytes and lists directories without following symlinks', async () => {
    await mkdir(join(root, 'a', 'b'), { recursive: true });
    await writeFile(join(root, 'a', 'b', 'f.txt'), '12345');
    await writeFile(join(root, 'top.txt'), '123');
    await symlink(join(root, 'a'), join(root, 'link-to-a'));
    expect(await treeBytes(root)).toBe(8);
    const kinds = (await walkTree(root)).map((entry) => entry.kind).sort();
    expect(kinds).toEqual(['dir', 'dir', 'file', 'file', 'symlink']);
  });

  it('accepts a symlink that resolves inside the tree, including through a chain', async () => {
    await writeFile(join(root, 'real.txt'), 'x');
    await symlink('real.txt', join(root, 'one'));
    await symlink('one', join(root, 'two'));
    await expect(assertNoEscapingSymlinks(root)).resolves.toBeUndefined();
  });

  it('refuses a symlink that points outside the tree', async () => {
    await symlink('/etc/hostname', join(root, 'leak'));
    await expect(assertNoEscapingSymlinks(root)).rejects.toBeInstanceOf(
      SbxSourceSymlinkEscapeError,
    );
  });

  it('refuses a relative symlink that climbs out of the tree through a chain', async () => {
    await symlink('../../outside', join(root, 'up'));
    await expect(assertNoEscapingSymlinks(root)).rejects.toBeInstanceOf(
      SbxSourceSymlinkEscapeError,
    );
  });

  it('refuses a dangling symlink, which cannot be proven to stay inside', async () => {
    await symlink(join(root, 'missing-target'), join(root, 'dangling'));
    await expect(assertNoEscapingSymlinks(root)).rejects.toBeInstanceOf(
      SbxSourceSymlinkEscapeError,
    );
  });

  it('makes a tree read-only and still removes it afterwards', async () => {
    const dir = join(root, 'staged');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'spec.yaml'), 'a: 1');
    await makeReadOnly(dir);
    expect((await stat(join(dir, 'nested', 'spec.yaml'))).mode & 0o222).toBe(0);
    expect((await stat(join(dir, 'nested'))).mode & 0o222).toBe(0);
    await expect(readFile(join(dir, 'nested', 'spec.yaml'), 'utf8')).resolves.toBe('a: 1');
    await forceRemove(dir);
    await expect(stat(dir)).rejects.toThrow();
    await expect(forceRemove(dir)).resolves.toBeUndefined();
  });
});
