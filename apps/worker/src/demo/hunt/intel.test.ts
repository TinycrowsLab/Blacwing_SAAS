import { describe, expect, it } from 'vitest';

import { EventLog, newHuntState, type HuntContext } from './context.js';
import { FakeStore } from './fake-store.js';
import { apexOf, briefingOf, detectBanners, INTEL_HOSTS, PRIVATE_SKIP_MESSAGE, redactEnvBody, runIntel, scanSecrets, targetsOf, type IntelDeps } from './intel.js';

import type { HuntRun } from './types.js';

const baseRun: HuntRun = {
  id: 'run-1',
  tenantId: 't',
  requestId: 'r',
  assetId: 'a',
  assetName: 'Asset',
  objective: 'test',
  scope: { allowedOrigins: ['https://www.shop.example.com'], excludedPaths: [] },
  budgetRequests: 100,
  budgetSeconds: 600,
  costCapUsd: 1,
  intrusiveness: 'active_safe',
  testAccounts: [],
  releaseProven: 'hold',
  labOrigins: [],
};
const AWS_KEY = 'AKIAQWERTYUIOPASDFGH';
const dns: IntelDeps = {
  resolveTxt: (name) => Promise.resolve(name === 'example.com' ? [['v=spf1 +all']] : []),
  resolveMx: () => Promise.resolve([{ exchange: 'mx.example.com', priority: 10 }]),
};

function setup(run: Partial<HuntRun>, respond: (url: string, init: RequestInit | undefined) => Response | undefined) {
  const store = new FakeStore();
  const urls: string[] = [];
  const ctx: HuntContext = {
    run: { ...baseRun, ...run },
    store,
    log: new EventLog(store, 'run-1', { warn: () => undefined, error: () => undefined }),
    signal: new AbortController().signal,
    deps: {
      fetch: (input, init) => {
        const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
        urls.push(url);
        return Promise.resolve(respond(url, init) ?? new Response('not found', { status: 404 }));
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
      gate2TimeoutMs: 1000,
      webhookUrl: null,
      consoleOrigin: 'http://console.test',
      lookup: () => Promise.resolve([{ address: '93.184.215.14' }]),
    },
    state: newHuntState(),
  };
  return { ctx, store, urls };
}

const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

describe('intel helpers', () => {
  it('finds the registrable domain without a target-specific list', () => {
    expect(apexOf('www.shop.example.com')).toBe('example.com');
    expect(apexOf('app.example.co.uk')).toBe('example.co.uk');
    expect(apexOf('127.0.0.1')).toBeNull();
    expect(apexOf('localhost')).toBeNull();
  });

  it('treats lab origins, loopback and private names as private', () => {
    expect(targetsOf({ ...baseRun, scope: { allowedOrigins: ['http://127.0.0.1:3001', 'http://localhost:8080'], excludedPaths: [] } }).apexes).toEqual([]);
    expect(targetsOf({ ...baseRun, scope: { allowedOrigins: ['https://lab.example.com'], excludedPaths: [] }, labOrigins: ['https://lab.example.com'] }).apexes).toEqual([]);
    expect(targetsOf(baseRun).apexes).toEqual(['example.com']);
  });

  it('redacts secrets and detects banners', () => {
    const hits = scanSecrets(`key = ${AWS_KEY}\nAKIAIOSFODNN7EXAMPLE`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.redacted).not.toContain('QWERTY');
    expect(redactEnvBody('DB_PASSWORD=hunter2hunter2\nAPP=x')).toBe('DB_PASSWORD=[redacted]\nAPP=[redacted]');
    expect(detectBanners({ server: 'nginx/1.18.0 (Ubuntu)', 'x-powered-by': 'PHP/7.4.3' }).map((b) => `${b.product} ${b.version}`)).toEqual(['nginx 1.18.0', 'php 7.4.3']);
  });
});

describe('runIntel', () => {
  it('skips the internet for a private target and says so', async () => {
    const { ctx, store, urls } = setup({ scope: { allowedOrigins: ['http://127.0.0.1:3001'], excludedPaths: [] } }, () => undefined);
    const result = await runIntel(ctx, { githubToken: 'tok', hibpApiKey: 'key' }, dns);
    expect(result.skipped).toBe(PRIVATE_SKIP_MESSAGE);
    // Only the scoped target probes went out; no public intel host was contacted.
    expect(urls.every((u) => u.startsWith('http://127.0.0.1:3001/'))).toBe(true);
    expect(store.events.some((e) => e.kind === 'intel.summary' && e.message === PRIVATE_SKIP_MESSAGE)).toBe(true);
  });

  it('gathers public intel through the allow-list, never tests discovered hosts and keeps secrets and people out', async () => {
    const env = 'DB_PASSWORD=supersecretvalue1\nAPP_KEY=abcdef';
      const auth: string[] = [];
    const { ctx, store, urls } = setup({}, (url, init) => {
      const host = new URL(url).hostname;
      if (host === 'crt.sh') return jsonResponse([{ name_value: 'www.shop.example.com\nstaging.example.com\n*.dev.example.com\nevil.other.net' }]);
      if (host === 'web.archive.org') return jsonResponse([['original'], ['https://old.example.com/backup.sql?token=abc'], ['https://www.shop.example.com/admin/'], ['https://www.shop.example.com/index.html']]);
      if (host === 'api.github.com') {
        auth.push((init?.headers as Record<string, string>).authorization ?? '');
        return jsonResponse({ total_count: 2, items: [{ path: 'a.env', repository: { full_name: 'someone/private', owner: { type: 'User' } }, text_matches: [{ fragment: `aws=${AWS_KEY}` }] }] });
      }
      if (host === 'haveibeenpwned.com') return jsonResponse({ alice: ['Adobe'], bob: ['Adobe', 'LinkedIn'] });
      if (host === 'services.nvd.nist.gov') return jsonResponse({ vulnerabilities: [{ cve: { id: 'CVE-2021-0001', descriptions: [{ lang: 'en', value: 'x' }], metrics: { cvssMetricV31: [{ cvssData: { baseScore: 9.8 } }] } } }] });
      if (url === 'https://www.shop.example.com/.git/HEAD') return new Response('ref: refs/heads/main\n', { status: 200 });
      if (url === 'https://www.shop.example.com/.env') return new Response(env, { status: 200 });
      if (url === 'https://www.shop.example.com/') return new Response('<html>', { status: 200, headers: { server: 'nginx/1.18.0' } });
      return undefined;
    });
    const result = await runIntel(ctx, { githubToken: 'tok', hibpApiKey: 'key' }, dns);

    expect(auth).toEqual(['Bearer tok']);
    expect(result.skipped).toBeNull();
    expect(result.discoveredHosts).toEqual(['dev.example.com', 'old.example.com', 'staging.example.com']);
    // No discovered host was ever contacted, and every public call stayed on the allow-list.
    const hosts = urls.map((u) => new URL(u).hostname);
    expect(hosts.filter((h) => !INTEL_HOSTS.includes(h))).toEqual(hosts.filter((h) => h === 'www.shop.example.com'));
    expect(hosts.some((h) => h.includes('staging') || h.includes('old.'))).toBe(false);
    expect(result.archivedPaths).toEqual(['/admin/']);

    const titles = result.items.map((i) => `${i.basis}: ${i.title}`);
    expect(titles).toContain('finding: Exposed Git repository metadata (/.git/HEAD)');
    expect(titles).toContain('finding: Exposed environment file (/.env)');
    expect(titles.some((t) => t.startsWith('unverified: Possible AWS access key id'))).toBe(true);
    expect(titles).toContain('unverified: 2 corporate e-mail addresses at example.com appear in public breaches');
    expect(titles).toContain('observed: SPF for example.com allows any sender');
    expect(result.items.some((i) => i.detail.includes('CVE-2021-0001'))).toBe(true);
    // Organisation level only: no personal repository, alias or full secret anywhere.
    const everything = JSON.stringify([result, store.events, store.findings]);
    expect(everything).not.toContain('someone/private');
    expect(everything).not.toContain('alice');
    expect(everything).not.toContain(AWS_KEY);
    expect(everything).not.toContain('supersecretvalue1');
    expect(store.findings.map((f) => f.status)).toEqual(['confirmed', 'confirmed']);
    expect(briefingOf(result)).toContain('Do not test them');
  });

  it('skips keyed sources without keys and stays inside the call cap', async () => {
    const { ctx, store } = setup({ budgetRequests: 10 }, () => undefined);
    const result = await runIntel(ctx, { githubToken: null, hibpApiKey: null }, dns);
    const notes = result.sources.filter((s) => s.status === 'skipped').map((s) => s.id);
    expect(notes).toEqual(['github', 'hibp']);
    expect(result.callsUsed).toBeLessThanOrEqual(8);
    expect(store.events.filter((e) => e.kind.startsWith('intel.')).length).toBeGreaterThan(0);
  });
});
