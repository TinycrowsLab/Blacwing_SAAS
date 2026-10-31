import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { SbxSourceAuthFailedError } from './errors.js';

const execFileAsync = promisify(execFile);

/** Clone and fetch limit. A checkout that takes longer is killed and reported as a plain failure. */
const GIT_TIMEOUT_MS = 300_000;
const GIT_MAX_BUFFER = 1_048_576;
/** Fixed PATH for git: the controller's environment is never inherited (CLAUDE.md, config is the only reader). */
const GIT_PATH = '/usr/bin:/bin:/usr/local/bin';

/** Stderr shapes git prints when it cannot authenticate (private repo, bad or missing deploy token). */
const AUTH_FAILURE_PATTERN =
  /Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)|The requested URL returned error: 40[13]|Repository not found/;

/** True when git's stderr says the remote refused the credential (or none was offered). */
export function isGitAuthFailure(stderr: string): boolean {
  return AUTH_FAILURE_PATTERN.test(stderr);
}

export interface GitCheckoutRequest {
  /** An `https:` URL without userinfo (validated by the stager). Never carries a credential. */
  readonly url: string;
  /** Branch, tag or commit to fetch (validated by the stager). `HEAD` when absent. */
  readonly ref: string;
  /** An existing empty directory that becomes the work tree. */
  readonly dest: string;
  /** Deploy token resolved from the secret store. Passed only in the git child's environment, never in argv. */
  readonly bearerToken?: string;
  /** Manifest paths to check out (sparse). Omitted for a full shallow checkout. */
  readonly sparsePaths?: readonly string[];
}

/** Shallow, credential-free source checkout. The stager depends on this port, not on the git binary. */
export interface GitCloner {
  checkout(request: GitCheckoutRequest): Promise<void>;
}

/** Git environment: no global or system config, no prompts, and the token only as an HTTP header for this child. */
export function gitEnvironment(bearerToken?: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: GIT_PATH,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ASKPASS: '/bin/false',
  };
  if (bearerToken !== undefined) {
    const basic = Buffer.from(`x-access-token:${bearerToken}`, 'utf8').toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return env;
}

/** Runs git with an argument array (never a shell string). Auth failures are classified; the rest are plain. */
async function runGit(
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  try {
    await execFileAsync('git', [...args], {
      cwd,
      env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
    if (isGitAuthFailure(stderr)) throw new SbxSourceAuthFailedError({ cause: error });
    throw new Error(`git ${args[0] ?? ''} failed`, { cause: error });
  }
}

/**
 * Shallow checkout without ever writing a credential to disk: `git init`, then one `fetch --depth 1` of the
 * ref, then a detached checkout of FETCH_HEAD. The remote is the bare URL, so `.git/config` holds no secret.
 */
export function shellGitCloner(): GitCloner {
  return {
    async checkout({ url, ref, dest, bearerToken, sparsePaths }) {
      const env = gitEnvironment(bearerToken);
      await runGit(['init', '--quiet'], dest, env);
      if (sparsePaths !== undefined && sparsePaths.length > 0) {
        await runGit(['sparse-checkout', 'init', '--no-cone'], dest, env);
        await runGit(['sparse-checkout', 'set', '--no-cone', '--', ...sparsePaths], dest, env);
      }
      await runGit(['remote', 'add', 'origin', url], dest, env);
      await runGit(['fetch', '--quiet', '--depth', '1', '--no-tags', 'origin', ref], dest, env);
      await runGit(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dest, env);
    },
  };
}

const USERINFO_IN_URL = /^(\s*url\s*=\s*https?:\/\/)[^/@\s]+@/gm;
const EXTRAHEADER_LINE = /^\s*extraheader\s*=.*\r?\n?/gm;

/**
 * Removes credentials from a git config file: userinfo in remote URLs and any `extraheader` (where a bearer
 * header would live). The checkout writes neither, so this is defence in depth and the rewrite is what the
 * "no credentials in .git/config" assertion checks.
 */
export async function stripGitConfigCredentials(configPath: string): Promise<void> {
  const text = await readFile(configPath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  });
  if (text === null) return;
  const cleaned = text.replace(USERINFO_IN_URL, '$1').replace(EXTRAHEADER_LINE, '');
  if (cleaned !== text) await writeFile(configPath, cleaned, { mode: 0o600 });
}
