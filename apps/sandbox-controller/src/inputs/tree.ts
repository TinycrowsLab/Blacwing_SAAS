import { chmod, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';

import { SbxInputIntegrityFailedError, SbxSourceSymlinkEscapeError } from './errors.js';

const DIR_MODE_READ_ONLY = 0o555;
const FILE_MODE_READ_ONLY = 0o444;
const DIR_MODE_WRITABLE = 0o700;

export interface TreeEntry {
  /** Path relative to the walked root, using the platform separator. */
  readonly relPath: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  /** Byte size of a regular file; zero for directories and symlinks. */
  readonly bytes: number;
}

/**
 * Lists every entry under `root` without following symlinks (lstat). Special files (fifos, sockets, devices)
 * are refused: a run input is data, never a device the sandbox could reach through a mount.
 */
export async function walkTree(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const pending: string[] = [''];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const dirents = await readdir(join(root, next));
    for (const name of dirents) {
      const relPath = join(next, name);
      const stat = await lstat(join(root, relPath));
      if (stat.isSymbolicLink()) {
        entries.push({ relPath, kind: 'symlink', bytes: 0 });
      } else if (stat.isDirectory()) {
        entries.push({ relPath, kind: 'dir', bytes: 0 });
        pending.push(relPath);
      } else if (stat.isFile()) {
        entries.push({ relPath, kind: 'file', bytes: stat.size });
      } else {
        throw new SbxInputIntegrityFailedError(`unsupported file type in input tree: ${relPath}`);
      }
    }
  }
  return entries;
}

/** Total bytes of the regular files under `root` (symlinks and directories count as zero). */
export async function treeBytes(root: string): Promise<number> {
  const entries = await walkTree(root);
  return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Dereference guard: every symlink must resolve, through any chain of links, to a path inside
 * `root`. A dangling link is refused too, since it cannot be proven to stay inside the checkout.
 */
export async function assertNoEscapingSymlinks(root: string): Promise<void> {
  const realRoot = await realpath(root);
  for (const entry of await walkTree(root)) {
    if (entry.kind !== 'symlink') continue;
    let target: string;
    try {
      target = await realpath(join(root, entry.relPath));
    } catch {
      throw new SbxSourceSymlinkEscapeError(`unresolvable symlink in source: ${entry.relPath}`);
    }
    if (!isInside(realRoot, target)) {
      throw new SbxSourceSymlinkEscapeError(
        `symlink points outside the source checkout: ${entry.relPath}`,
      );
    }
  }
}

/**
 * Makes the tree read-only for the sandbox user: files 0444, directories 0555. Symlinks are left alone (their
 * mode is not meaningful and chmod would follow them).
 */
export async function makeReadOnly(root: string): Promise<void> {
  await chmod(root, DIR_MODE_READ_ONLY);
  for (const entry of await walkTree(root)) {
    if (entry.kind === 'file') await chmod(join(root, entry.relPath), FILE_MODE_READ_ONLY);
    if (entry.kind === 'dir') await chmod(join(root, entry.relPath), DIR_MODE_READ_ONLY);
  }
}

/**
 * Removes `dir` even when it was made read-only: directories are made writable first, since removing an entry
 * needs write permission on its parent. A missing directory is not an error. Symlinks are unlinked, not followed.
 */
export async function forceRemove(dir: string): Promise<void> {
  const stat = await lstat(dir).catch((error: unknown) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (stat === null) return;
  if (stat.isDirectory()) {
    await chmod(dir, DIR_MODE_WRITABLE);
    for (const entry of await walkTree(dir)) {
      if (entry.kind === 'dir') await chmod(join(dir, entry.relPath), DIR_MODE_WRITABLE);
    }
  }
  await rm(dir, { recursive: true, force: true });
}

/** Creates an empty directory and its parents. Callers remove any stale stage first with `forceRemove`. */
export async function makeFreshDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE_WRITABLE });
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
