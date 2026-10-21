import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../playwright.config.js';
import {
  DEFAULT_TEST_USER,
  E2eConfigError,
  isLoopbackHost,
  readEnvFile,
  requireLoopbackUrl,
  requireTestPassword,
  resolveE2eSettings,
} from './env.js';

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', 'juice.bw.localhost', '127.0.0.1', '127.255.0.9', '[::1]'])(
    'accepts %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    'example.com',
    '10.0.0.1',
    '0.0.0.0',
    '128.0.0.1',
    '127.0.0.256',
    'localhost.evil.test',
    '127.0.0',
  ])('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('requireLoopbackUrl (fails closed)', () => {
  it('accepts the dev defaults', () => {
    expect(requireLoopbackUrl('K', 'http://127.0.0.1:13000').port).toBe('13000');
    expect(requireLoopbackUrl('K', 'https://juice.bw.localhost:13443').hostname).toBe(
      'juice.bw.localhost',
    );
  });

  it('rejects off-host targets, other schemes, embedded credentials and garbage', () => {
    expect(() => requireLoopbackUrl('K', 'https://demo.owasp-juice.shop')).toThrow(E2eConfigError);
    expect(() => requireLoopbackUrl('K', 'ftp://127.0.0.1/')).toThrow(/http or https/);
    expect(() => requireLoopbackUrl('K', 'http://u:p@127.0.0.1/')).toThrow(/credentials/);
    expect(() => requireLoopbackUrl('K', 'not a url')).toThrow(/not a valid URL/);
  });

  it('never echoes a credential in its error', () => {
    let message = '';
    try {
      requireLoopbackUrl('K', 'http://user:hunter2-secret@127.0.0.1/');
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/credentials/);
    expect(message).not.toContain('hunter2-secret');
  });
});

describe('resolveE2eSettings', () => {
  it('uses the .env.example defaults when nothing is set', () => {
    const s = resolveE2eSettings({}, {});
    expect(s.targetUrl.href).toBe('http://127.0.0.1:13000/');
    expect(s.keycloakUrl.href).toBe('http://localhost:18080/');
    expect(s.webUrl.href).toBe('http://127.0.0.1:3000/');
    expect(s.realm).toBe('blackwing-dev');
    expect(s.testUser).toBe(DEFAULT_TEST_USER);
    expect(s.testPassword).toBeUndefined();
  });

  it('lets the process environment override .env (compose precedence)', () => {
    const s = resolveE2eSettings(
      {
        BW_TARGET_JUICE_SHOP_URL: 'http://127.0.0.1:13000',
        BW_DEV_KEYCLOAK_TEST_USER_PASSWORD: 'file',
      },
      { BW_TARGET_JUICE_SHOP_URL: 'http://127.0.0.1:23000', BW_E2E_TEST_USER: 'dev@acme.test' },
    );
    expect(s.targetUrl.port).toBe('23000');
    expect(s.testUser).toBe('dev@acme.test');
    expect(s.testPassword).toBe('file');
  });

  it('treats empty values as unset', () => {
    const s = resolveE2eSettings({ BW_TARGET_JUICE_SHOP_URL: '' }, { BW_E2E_TEST_USER: '' });
    expect(s.targetUrl.port).toBe('13000');
    expect(s.testUser).toBe(DEFAULT_TEST_USER);
  });

  it('refuses a non-loopback target before any browser starts', () => {
    expect(() =>
      resolveE2eSettings({}, { BW_TARGET_JUICE_SHOP_URL: 'http://203.0.113.7' }),
    ).toThrow(/loopback/);
  });

  it('names the missing password key without a value', () => {
    expect(() => requireTestPassword(resolveE2eSettings({}, {}))).toThrow(
      /BW_DEV_KEYCLOAK_TEST_USER_PASSWORD is empty/,
    );
    expect(
      requireTestPassword(resolveE2eSettings({ BW_DEV_KEYCLOAK_TEST_USER_PASSWORD: 'x1' }, {})),
    ).toBe('x1');
  });
});

describe('readEnvFile', () => {
  it('parses a dotenv file and treats a missing one as empty', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-e2e-'));
    try {
      const file = path.join(dir, '.env');
      writeFileSync(file, '# comment\nBW_TARGET_JUICE_SHOP_URL=http://127.0.0.1:13000\n');
      expect(readEnvFile(file)).toEqual({ BW_TARGET_JUICE_SHOP_URL: 'http://127.0.0.1:13000' });
      expect(readEnvFile(path.join(dir, 'absent.env'))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('playwright config', () => {
  const projects = config.projects ?? [];
  const byName = (name: string) => projects.find((p) => p.name === name);

  it('runs headless Chromium on a UTC clock and forbids focused tests', () => {
    expect(config.forbidOnly).toBe(true);
    expect(config.use?.headless).toBe(true);
    expect(config.use?.timezoneId).toBe('UTC');
    expect(projects.map((p) => p.use?.browserName)).toEqual(['chromium', 'chromium']);
  });

  it('retries only navigation, once, with a trace on the first retry', () => {
    expect(byName('navigation')?.retries).toBe(1);
    expect(byName('navigation')?.use?.trace).toBe('on-first-retry');
    expect(byName('flows')?.retries).toBe(0);
  });

  it('keeps a trace, video and screenshot of every failure', () => {
    expect(config.use?.trace).toBe('retain-on-failure');
    expect(config.use?.video).toBe('retain-on-failure');
    expect(config.use?.screenshot).toBe('only-on-failure');
  });

  it('writes the HTML report and JSON results where the workflow uploads them', () => {
    const reporters = JSON.stringify(config.reporter);
    expect(reporters).toContain('../playwright-report');
    expect(reporters).toContain('../test-results/results.json');
    expect(config.outputDir).toBe('../test-results/artifacts');
  });
});
