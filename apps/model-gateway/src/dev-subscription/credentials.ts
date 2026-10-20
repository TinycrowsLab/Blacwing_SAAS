// POC-ONLY / offline-stub (#883). OFFLINE-STUB(online-porting #884): production credentials come from
// OpenBao per tenant/provider, never from a developer login.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { markSecret, type Secret } from '@blackwing/config';
import { AppError } from '@blackwing/errors';

/** Where the Claude Code CLI keeps its login on Linux and WSL (the macOS keychain is not supported). */
export function defaultClaudeCodeCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

/** Shape of the Claude Code credential file; only the fields the gateway needs are read. */
const credentialsFileSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    /** Epoch milliseconds. */
    expiresAt: z.number().int().positive().optional(),
  }),
});

export type DevLoginProblem = 'missing' | 'invalid' | 'expired';

/** The developer login could not be used. The message never contains file content or token material. */
export class DevSubscriptionLoginError extends AppError {
  readonly problem: DevLoginProblem;
  constructor(problem: DevLoginProblem, message: string) {
    super('UNAUTHENTICATED', message);
    this.problem = problem;
  }
}

export interface DevSubscriptionCredential {
  readonly accessToken: Secret;
  /** Every secret value of the login (access and refresh token), for value-based redaction. */
  readonly secretValues: readonly Secret[];
  readonly expiresAt: number | undefined;
}

export interface DevSubscriptionCredentialSource {
  /** Reads the current login. Throws {@link DevSubscriptionLoginError}; never falls back to another credential. */
  read(): Promise<DevSubscriptionCredential>;
}

export interface ClaudeCodeLoginStoreOptions {
  readonly path?: string | undefined;
  /** Injected for tests. */
  readonly now?: () => number;
}

const RELOGIN_HINT = 'Sign in again with the Claude Code CLI on the gateway host.';

/**
 * Reads the host user's Claude Code login from its credential file, inside the gateway process only.
 * The file is re-read on every request so a login the CLI refreshed is picked up, and an expired one is
 * reported instead of being used. The gateway never refreshes the login itself and never copies it into
 * env, config, logs or traces: every value is registered for redaction the moment it is parsed.
 */
export class ClaudeCodeLoginStore implements DevSubscriptionCredentialSource {
  readonly #path: string;
  readonly #now: () => number;

  constructor(options: ClaudeCodeLoginStoreOptions = {}) {
    this.#path = options.path ?? defaultClaudeCodeCredentialsPath();
    this.#now = options.now ?? Date.now;
  }

  async read(): Promise<DevSubscriptionCredential> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch {
      throw new DevSubscriptionLoginError(
        'missing',
        `No local Claude Code login found for the dev subscription provider. ${RELOGIN_HINT}`,
      );
    }
    const parsed = credentialsFileSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      throw new DevSubscriptionLoginError(
        'invalid',
        `The local Claude Code login is unreadable. ${RELOGIN_HINT}`,
      );
    }
    const login = parsed.data.claudeAiOauth;
    const accessToken = markSecret(login.accessToken);
    const secretValues =
      login.refreshToken === undefined
        ? [accessToken]
        : [accessToken, markSecret(login.refreshToken)];
    if (login.expiresAt !== undefined && login.expiresAt <= this.#now()) {
      throw new DevSubscriptionLoginError(
        'expired',
        `The local Claude Code login has expired. ${RELOGIN_HINT}`,
      );
    }
    return { accessToken, secretValues, expiresAt: login.expiresAt };
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
