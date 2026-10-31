import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SbxSourceAuthFailedError } from './errors.js';
import {
  gitEnvironment,
  isGitAuthFailure,
  shellGitCloner,
  stripGitConfigCredentials,
} from './git.js';

const run = promisify(execFile);
const GIT_IDENTITY = ['-c', 'user.name=bw-test', '-c', 'user.email=bw-test@example.invalid'];

describe('gitEnvironment', () => {
  it('passes the deploy token only as an HTTP header for the git child', () => {
    const env = gitEnvironment('tok-abc');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(
      Buffer.from(
        env.GIT_CONFIG_VALUE_0?.replace('Authorization: Basic ', '') ?? '',
        'base64',
      ).toString(),
    ).toBe('x-access-token:tok-abc');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
  });

  it('sets no credential when there is no token', () => {
    const env = gitEnvironment(undefined);
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(Object.values(env).join(' ')).not.toContain('Authorization');
  });
});

describe('isGitAuthFailure', () => {
  it.each([
    'remote: Invalid username or password.\nfatal: Authentication failed for https://example.com/a.git/',
    "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
    'git@example.com: Permission denied (publickey).',
    "remote: Repository not found.\nfatal: repository 'https://example.com/acme/app.git/' not found",
  ])('classifies %j as an auth failure', (stderr) => {
    expect(isGitAuthFailure(stderr)).toBe(true);
  });

  it('does not classify a network error as an auth failure', () => {
    expect(
      isGitAuthFailure("fatal: unable to access 'https://example.com/': Could not resolve host"),
    ).toBe(false);
  });
});

describe('stripGitConfigCredentials', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bw-gitcfg-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes userinfo from remote URLs and any extraheader line', async () => {
    const path = join(dir, 'config');
    await writeFile(
      path,
      [
        '[remote "origin"]',
        '\turl = https://x-access-token:ghp_secret@example.com/acme/app.git',
        '[http]',
        '\textraheader = Authorization: Basic c2VjcmV0',
        '',
      ].join('\n'),
    );
    await stripGitConfigCredentials(path);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('url = https://example.com/acme/app.git');
    expect(text).not.toContain('ghp_secret');
    expect(text).not.toContain('extraheader');
  });

  it('does nothing when there is no config file', async () => {
    await expect(stripGitConfigCredentials(join(dir, 'missing'))).resolves.toBeUndefined();
  });
});

describe('shellGitCloner (real git, local repository)', () => {
  let work: string;
  let source: string;
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'bw-git-'));
    source = join(work, 'source');
    await mkdir(join(source, 'api'), { recursive: true });
    await mkdir(join(source, 'other'), { recursive: true });
    await writeFile(join(source, 'api', 'openapi.yaml'), 'openapi: 3.1.0');
    await writeFile(join(source, 'other', 'big.txt'), 'not in sparse set');
    await run('git', ['init', '--quiet', source]);
    await run('git', [...GIT_IDENTITY, '-C', source, 'add', '.']);
    await run('git', [...GIT_IDENTITY, '-C', source, 'commit', '--quiet', '-m', 'init']);
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('checks out the ref shallowly with no credential in .git/config', async () => {
    const dest = join(work, 'checkout');
    await mkdir(dest);
    await shellGitCloner().checkout({
      url: `file://${source}`,
      ref: 'HEAD',
      dest,
      bearerToken: 'tok-must-not-persist',
    });
    expect(await readFile(join(dest, 'api', 'openapi.yaml'), 'utf8')).toBe('openapi: 3.1.0');
    const config = await readFile(join(dest, '.git', 'config'), 'utf8');
    expect(config).not.toContain('tok-must-not-persist');
    expect(config).not.toContain('extraheader');
    expect((await stat(join(dest, '.git'))).isDirectory()).toBe(true);
  });

  it('checks out only the manifest paths when a sparse set is given', async () => {
    const dest = join(work, 'sparse');
    await mkdir(dest);
    await shellGitCloner().checkout({
      url: `file://${source}`,
      ref: 'HEAD',
      dest,
      sparsePaths: ['api/'],
    });
    expect(await readFile(join(dest, 'api', 'openapi.yaml'), 'utf8')).toBe('openapi: 3.1.0');
    await expect(stat(join(dest, 'other', 'big.txt'))).rejects.toThrow();
  });

  it('fails with a plain error for an unknown ref (not an auth failure)', async () => {
    const dest = join(work, 'bad-ref');
    await mkdir(dest);
    const error = await shellGitCloner()
      .checkout({ url: `file://${source}`, ref: 'no-such-branch', dest })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SbxSourceAuthFailedError);
  });
});
