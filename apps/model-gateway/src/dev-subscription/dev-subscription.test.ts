// Unit tests for the dev subscription provider (#883): env/flag matrix, boot refusal, credential file
// handling (missing, invalid, expired, refreshed), stream redaction and the banner.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CONFIG_EXIT_CODE } from '@blackwing/config';
import { createLogger } from '@blackwing/logger';

import { staticVirtualKeyVerifier, virtualKeyVerifier } from '../auth.js';
import { bootGateway, runGateway } from '../boot.js';
import { type BwEnvironment, loadGatewayConfig } from '../config.js';
import { DevSubscriptionAdapter } from './adapter.js';
import { announceDevSubscription } from './banner.js';
import { ClaudeCodeLoginStore, DevSubscriptionLoginError } from './credentials.js';
import {
  assertDevSubscriptionAllowed,
  DEV_SUBSCRIPTION_BANNER,
  devSubscriptionRefusal,
  DevSubscriptionRefusedError,
} from './guard.js';
import { redactSecretsInStream } from './redact-stream.js';

import type { GatewayAuditEvent } from '../audit.js';

/** Session keys are not used by these tests: every key is refused. */
const NO_SESSION_KEYS = virtualKeyVerifier(() => Promise.resolve(undefined));

const DEV_TENANT = '0192f7a0-0000-7000-8000-000000000001';
const DEV_KEY = `bwk_${randomBytes(24).toString('hex')}`;
const DEV_KEY_SHA = createHash('sha256').update(DEV_KEY).digest('hex');

/** A token in the subscription format, generated per run so none is ever committed. */
function fakeOauthToken(): string {
  return `sk-ant-oat01-${randomBytes(32).toString('base64url')}`;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function credentialsFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'bw-devsub-'));
  dirs.push(dir);
  const path = join(dir, '.credentials.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

function devEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    BW_ENV: 'dev',
    GATEWAY_PORT: '13599',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    GATEWAY_DEFAULT_PROVIDER: 'dev_subscription',
    GATEWAY_DEV_SUBSCRIPTION_ENABLED: 'true',
    GATEWAY_DEV_SUBSCRIPTION_TENANT_IDS: DEV_TENANT,
    GATEWAY_DEV_VIRTUAL_KEY_SHA256: DEV_KEY_SHA,
    GATEWAY_DEV_SUBSCRIPTION_CREDENTIALS_FILE: '/nonexistent/.credentials.json',
    ...overrides,
  };
}

const silentLogger = createLogger('devsub-test', { level: 'silent', nodeEnv: 'test' });

describe('dev subscription env guard (flag matrix)', () => {
  const environments: (BwEnvironment | undefined)[] = [
    'dev',
    'test',
    'staging',
    'production',
    undefined,
  ];
  for (const env of environments) {
    for (const enabled of [true, false]) {
      const allowed = env === 'dev' && enabled;
      it(`BW_ENV=${env ?? 'unset'} flag=${String(enabled)} is ${allowed ? 'allowed' : 'refused'}`, () => {
        const input = { BW_ENV: env, GATEWAY_DEV_SUBSCRIPTION_ENABLED: enabled };
        expect(devSubscriptionRefusal(input) === undefined).toBe(allowed);
        let thrown: unknown;
        try {
          assertDevSubscriptionAllowed(input);
        } catch (error) {
          thrown = error;
        }
        expect(thrown instanceof DevSubscriptionRefusedError).toBe(!allowed);
      });
    }
  }

  it('the adapter cannot be constructed outside dev (code-level guard, not config only)', () => {
    expect(
      () =>
        new DevSubscriptionAdapter({
          baseUrl: 'http://127.0.0.1:9',
          credentials: new ClaudeCodeLoginStore({ path: '/nonexistent' }),
          allowedTenantIds: [DEV_TENANT],
          environment: () => ({ BW_ENV: 'production', GATEWAY_DEV_SUBSCRIPTION_ENABLED: true }),
        }),
    ).toThrow(DevSubscriptionRefusedError);
  });
});

describe('boot refusal', () => {
  for (const env of ['test', 'staging', 'production']) {
    it(`exits with CONFIG_EXIT_CODE and never listens with BW_ENV=${env}`, async () => {
      const exit = vi.fn<(code: number) => void>();
      const app = await runGateway({
        source: devEnv({ BW_ENV: env }),
        exit,
        write: () => undefined,
        logger: silentLogger,
        verifier: NO_SESSION_KEYS,
      });
      expect(app).toBeUndefined();
      expect(exit).toHaveBeenCalledWith(CONFIG_EXIT_CODE);
    });
  }

  it('exits when BW_ENV is unset', async () => {
    const env = devEnv();
    delete env.BW_ENV;
    const exit = vi.fn<(code: number) => void>();
    expect(
      await runGateway({
        source: env,
        exit,
        write: () => undefined,
        logger: silentLogger,
        verifier: NO_SESSION_KEYS,
      }),
    ).toBeUndefined();
    expect(exit).toHaveBeenCalledWith(CONFIG_EXIT_CODE);
  });

  it('refuses dev_subscription as default provider without the explicit flag', () => {
    const config = loadGatewayConfig(devEnv({ GATEWAY_DEV_SUBSCRIPTION_ENABLED: 'false' }));
    expect(() =>
      bootGateway(config, {
        logger: silentLogger,
        write: () => undefined,
        verifier: NO_SESSION_KEYS,
      }),
    ).toThrow(/GATEWAY_DEV_SUBSCRIPTION_ENABLED=true/);
  });

  it('refuses the flag in a non-dev env even when the default provider is anthropic', () => {
    const config = loadGatewayConfig(
      devEnv({ BW_ENV: 'production', GATEWAY_DEFAULT_PROVIDER: 'anthropic' }),
    );
    expect(() =>
      bootGateway(config, {
        logger: silentLogger,
        write: () => undefined,
        verifier: NO_SESSION_KEYS,
      }),
    ).toThrow(DevSubscriptionRefusedError);
  });

  it('refuses without a dev tenant or a virtual key hash', () => {
    for (const missing of [
      'GATEWAY_DEV_SUBSCRIPTION_TENANT_IDS',
      'GATEWAY_DEV_VIRTUAL_KEY_SHA256',
    ]) {
      const env = Object.fromEntries(Object.entries(devEnv()).filter(([key]) => key !== missing));
      expect(() =>
        bootGateway(loadGatewayConfig(env), {
          logger: silentLogger,
          write: () => undefined,
          verifier: NO_SESSION_KEYS,
        }),
      ).toThrow(DevSubscriptionRefusedError);
    }
  });

  it('boots the plain anthropic provider unchanged when the dev provider is not requested', () => {
    const config = loadGatewayConfig(
      devEnv({
        BW_ENV: 'production',
        GATEWAY_DEFAULT_PROVIDER: 'anthropic',
        GATEWAY_DEV_SUBSCRIPTION_ENABLED: 'false',
      }),
    );
    const written: string[] = [];
    const booted = bootGateway(config, {
      logger: silentLogger,
      write: (t) => written.push(t),
      verifier: NO_SESSION_KEYS,
    });
    booted.stop();
    expect(written).toEqual([]);
  });
});

describe('ClaudeCodeLoginStore', () => {
  it('reads the access token and registers every login value as a secret', async () => {
    const token = fakeOauthToken();
    const refresh = fakeOauthToken();
    const store = new ClaudeCodeLoginStore({
      path: credentialsFile({
        claudeAiOauth: {
          accessToken: token,
          refreshToken: refresh,
          expiresAt: Date.now() + 60_000,
        },
      }),
    });
    const credential = await store.read();
    expect(credential.accessToken).toBe(token);
    expect(credential.secretValues).toEqual([token, refresh]);
  });

  it('reports a missing login clearly without falling back', async () => {
    const error = await new ClaudeCodeLoginStore({ path: '/nonexistent/x.json' })
      .read()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DevSubscriptionLoginError);
    expect((error as DevSubscriptionLoginError).problem).toBe('missing');
  });

  it('reports an unreadable file without echoing its content', async () => {
    const token = fakeOauthToken();
    const error = await new ClaudeCodeLoginStore({ path: credentialsFile(`{"oops":"${token}"`) })
      .read()
      .catch((e: unknown) => e);
    expect((error as DevSubscriptionLoginError).problem).toBe('invalid');
    expect((error as Error).message).not.toContain(token);
  });

  it('reports an expired login and picks up a refreshed one on the next read', async () => {
    const now = Date.now();
    const path = credentialsFile({
      claudeAiOauth: { accessToken: fakeOauthToken(), expiresAt: now - 1 },
    });
    const store = new ClaudeCodeLoginStore({ path, now: () => now });
    const error = await store.read().catch((e: unknown) => e);
    expect((error as DevSubscriptionLoginError).problem).toBe('expired');
    expect((error as Error).message).toMatch(/expired.*Claude Code CLI/);

    const refreshed = fakeOauthToken();
    writeFileSync(
      path,
      JSON.stringify({ claudeAiOauth: { accessToken: refreshed, expiresAt: now + 1 } }),
    );
    expect((await store.read()).accessToken).toBe(refreshed);
  });
});

async function collect(
  chunks: string[],
  secrets: string[],
): Promise<{ text: string; parts: number }> {
  async function* source(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield await Promise.resolve(Buffer.from(chunk, 'utf8'));
  }
  const out: Buffer[] = [];
  for await (const part of redactSecretsInStream(source(), secrets)) out.push(Buffer.from(part));
  return { text: Buffer.concat(out).toString('utf8'), parts: out.length };
}

describe('redactSecretsInStream', () => {
  const secret = 'sk-ant-oat01-SECRETVALUE';

  it('redacts a secret split across chunk boundaries', async () => {
    const { text } = await collect(['data: x sk-a', 'nt-oat01-SEC', 'RETVALUE y\n\n'], [secret]);
    expect(text).toBe('data: x [REDACTED] y\n\n');
  });

  it('redacts repeated and multiple secrets', async () => {
    const other = 'refresh-XYZ';
    const { text } = await collect([`${secret}${secret} ${other}`], [secret, other]);
    expect(text).toBe('[REDACTED][REDACTED] [REDACTED]');
  });

  it('flushes a held-back partial match that turns out not to be a secret', async () => {
    const { text } = await collect(['abc sk-ant', ' done'], [secret]);
    expect(text).toBe('abc sk-ant done');
  });

  it('passes ordinary chunks through without holding them back', async () => {
    const { parts } = await collect(['event: a\n\n', 'event: b\n\n'], [secret]);
    expect(parts).toBe(2);
  });
});

describe('staticVirtualKeyVerifier', () => {
  const verifier = staticVirtualKeyVerifier({ keySha256Hex: DEV_KEY_SHA, tenantId: DEV_TENANT });
  it('accepts only the configured bwk_ key', () => {
    expect(verifier.verify(DEV_KEY)).toMatchObject({ tenantId: DEV_TENANT });
    expect(verifier.verify(`${DEV_KEY}x`)).toBeUndefined();
    expect(verifier.verify(DEV_KEY.replace('bwk_', 'xyz_'))).toBeUndefined();
  });
});

describe('announceDevSubscription', () => {
  it('prints the banner, audits activation and repeats a WARN line', () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const logger = createLogger('devsub-banner', {
      level: 'debug',
      nodeEnv: 'test',
      destination: { write: (line: string) => lines.push(line) },
    });
    const events: GatewayAuditEvent[] = [];
    const written: string[] = [];
    const stop = announceDevSubscription({
      logger,
      audit: { record: (event) => events.push(event) },
      intervalMs: 1_000,
      write: (text) => written.push(text),
    });
    expect(written.join('')).toContain(DEV_SUBSCRIPTION_BANNER);
    expect(events).toEqual([{ type: 'gateway.dev_provider.active', provider: 'dev_subscription' }]);
    vi.advanceTimersByTime(3_000);
    stop();
    vi.advanceTimersByTime(3_000);
    const warns = lines
      .map((line) => JSON.parse(line) as { level: number | string; msg: string; provider: string })
      .filter((line) => line.msg === DEV_SUBSCRIPTION_BANNER);
    expect(warns).toHaveLength(4);
    expect(warns.every((line) => line.provider === 'dev_subscription')).toBe(true);
  });
});
