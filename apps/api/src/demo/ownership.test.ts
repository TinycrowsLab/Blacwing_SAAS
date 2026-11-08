// DEMO-STORY target allow/deny rules: Blackwing itself and cloud metadata are never testable, private addresses only
// as operator-listed labs, and BW_LAB_ORIGINS refuses to boot with a platform or metadata origin in it.
import { describe, expect, it } from 'vitest';

import { loadDemoConfig } from './config.js';
import { classifyOrigin, firstRefusal, type Lookup, type OriginPolicy } from './ownership.js';

const policy: OriginPolicy = {
  labOrigins: ['http://127.0.0.1:3001'],
  platformOrigins: ['http://localhost:3000', 'http://127.0.0.1:13400'],
  platformPorts: [3000, 13400, 13401],
};

const DNS: Record<string, string[]> = {
  'shop.example.com': ['93.184.216.34'],
  localhost: ['127.0.0.1', '::1'],
  'rebind.example.com': ['169.254.169.254'],
  'intranet.example.com': ['10.0.0.7'],
  'mixed.example.com': ['93.184.216.34', '192.168.1.4'],
};
const lookup: Lookup = (host) => {
  if (/^[\d.]+$/.test(host) || host.includes(':')) return Promise.resolve([host]);
  const found = DNS[host];
  return found === undefined ? Promise.reject(new Error('ENOTFOUND')) : Promise.resolve(found);
};

describe('classifyOrigin', () => {
  it.each([
    ['http://localhost:3000', 'platform'],
    ['http://127.0.0.1:13400', 'platform'],
    ['http://127.0.0.1:3000', 'platform'],
    ['http://[::1]:13401', 'platform'],
    ['http://169.254.169.254', 'forbidden'],
    ['https://169.254.169.254', 'forbidden'],
    ['http://metadata.google.internal', 'forbidden'],
    ['http://[fe80::1]', 'forbidden'],
    ['http://0.0.0.0:8080', 'forbidden'],
    ['http://rebind.example.com', 'forbidden'],
    ['http://127.0.0.1:3001', 'private'],
    ['http://127.0.0.1:8091', 'private'],
    ['http://intranet.example.com', 'private'],
    ['http://mixed.example.com', 'private'],
    ['https://shop.example.com', 'public'],
    ['https://nowhere.example.com', 'unresolved'],
  ])('%s is %s', async (origin, kind) => {
    expect(await classifyOrigin(origin, policy, lookup)).toBe(kind);
  });
});

describe('firstRefusal', () => {
  it('allows a public origin and a listed lab, and refuses the rest in plain words', async () => {
    expect(await firstRefusal(['https://shop.example.com', 'http://127.0.0.1:3001'], policy, lookup)).toBeNull();
    expect(await firstRefusal(['http://localhost:3000'], policy, lookup)).toBe(
      'Blackwing cannot test its own console or API.',
    );
    expect(await firstRefusal(['http://169.254.169.254'], policy, lookup)).toBe(
      'Cloud metadata and link-local addresses can never be tested.',
    );
    expect(await firstRefusal(['https://shop.example.com', 'http://127.0.0.1:8091'], policy, lookup)).toContain(
      'only when your Blackwing operator has listed it as a lab',
    );
  });
});

describe('BW_LAB_ORIGINS', () => {
  const env = {
    NODE_ENV: 'test',
    BW_DEMO_MODE: '1',
    BW_DEMO_INTERNAL_TOKEN: 'x'.repeat(32),
    BW_DEMO_TENANT_ID: 't1',
    DATABASE_URL: 'postgres://localhost/x',
    BW_CONSOLE_ORIGIN: 'http://localhost:3000',
    BW_DEMO_API_ORIGIN: 'http://127.0.0.1:13400',
    API_PORT: '13400',
  };

  it('parses the lab list into normalised origins', () => {
    const config = loadDemoConfig({ ...env, BW_LAB_ORIGINS: 'http://127.0.0.1:3001/, http://127.0.0.1:5077' });
    expect(config.origins.labOrigins).toEqual(['http://127.0.0.1:3001', 'http://127.0.0.1:5077']);
    expect(config.origins.platformPorts).toEqual(expect.arrayContaining([3000, 13400, 13401]));
    expect(config.huntConcurrency).toBe(3);
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:13400', 'http://169.254.169.254', 'http://metadata', 'ftp://x'])(
    'refuses to boot with %s listed as a lab',
    (lab) => {
      expect(() => loadDemoConfig({ ...env, BW_LAB_ORIGINS: lab })).toThrow(/BW_LAB_ORIGINS/);
    },
  );
});
