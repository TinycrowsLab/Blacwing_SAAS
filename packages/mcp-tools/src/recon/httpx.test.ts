import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { parseScopeRules } from '@blackwing/contracts';

import { ToolError } from '../errors.js';
import {
  buildHttpxArgs,
  createHttpxMetrics,
  type HttpProbeContext,
  parseTech,
  probeHttp,
  spawnHttpx,
} from './httpx.js';

import type { SurfaceWriteContext, SurfaceWriteRequest } from '@blackwing/domain';

const TENANT = '0190a000-0000-7000-8000-0000000000aa';
const ASSET = '0190a000-0000-7000-8000-000000000001';
const RUN = '0190a000-0000-7000-8000-0000000000b1';
const SESSION = '0190a000-0000-7000-8000-0000000000b2';
const PROXY = 'http://egress.internal:3128';

const scope = parseScopeRules({ rules: [{ effect: 'include', host: '*.lab.example' }] });

const line = (row: Record<string, unknown>): string => JSON.stringify(row);

function setup(
  outputs: string[],
  over: Partial<HttpProbeContext> = {},
): {
  ctx: HttpProbeContext;
  run: ReturnType<typeof vi.fn>;
  writes: SurfaceWriteRequest[];
} {
  const writes: SurfaceWriteRequest[] = [];
  const write: SurfaceWriteContext = {
    tenantId: TENANT,
    scope,
    callTool: (_tool, input) => {
      writes.push(input.request);
      return Promise.resolve({ ok: true });
    },
    audit: () => undefined,
  };
  const run = vi.fn();
  for (const out of outputs) run.mockResolvedValueOnce(out);
  run.mockResolvedValue('');
  const ctx: HttpProbeContext = {
    write,
    assetId: ASSET,
    runId: RUN,
    sessionId: SESSION,
    toolVersion: '1.6.9',
    run,
    signal: new AbortController().signal,
    options: { proxyUrl: PROXY },
    sleep: () => Promise.resolve(),
    ...over,
  };
  return { ctx, run, writes };
}

const live = {
  url: 'https://app.lab.example',
  input: 'https://app.lab.example',
  status_code: 200,
  title: 'Welcome',
  webserver: 'nginx/1.18.0 (Ubuntu)',
  tech: ['Nginx:1.18.0', 'React', 'jQuery:3.6.0'],
  content_type: 'text/html',
  content_length: 512,
  header: { server: 'nginx/1.18.0', 'set-cookie': 'sid=abc', 'x-auth-token': 't', etag: '"1"' },
  tls: { version: 'tls13', self_signed: true, subject_cn: 'app.lab.example', cert_pem: 'SECRET' },
};

describe('parseTech', () => {
  it.each([
    ['Nginx:1.18.0', { product: 'Nginx', version: '1.18.0' }],
    ['React', { product: 'React' }],
    ['Apache HTTP Server:2.4.41', { product: 'Apache HTTP Server', version: '2.4.41' }],
    ['nginx/1.18.0 (Ubuntu)', { product: 'nginx', version: '1.18.0' }],
    ['Microsoft-IIS', { product: 'Microsoft-IIS' }],
  ])('%s', (raw, expected) => {
    expect(parseTech(raw)).toEqual(expected);
  });
  it('rejects empty and oversize names', () => {
    expect(parseTech('  ')).toBeNull();
    expect(parseTech('x'.repeat(200))).toBeNull();
  });
});

describe('buildHttpxArgs', () => {
  const base = {
    maxRedirects: 5,
    maxBodyBytes: 1000,
    ratePerSecond: 7,
    timeoutSeconds: 3,
    proxyUrl: PROXY,
  };
  it('proxies through the gateway, caps redirects and body, passes no scope flag', () => {
    const args = buildHttpxArgs(base);
    expect(args).toEqual(expect.arrayContaining(['-proxy', `${PROXY}/`, '-max-redirects', '5']));
    expect(args).toEqual(expect.arrayContaining(['-response-size-to-read', '1000']));
    expect(args).toEqual(expect.arrayContaining(['-rate-limit', '7', '-json']));
    expect(args.some((a) => /scope|allow|deny/i.test(a))).toBe(false);
  });
  it('rejects a non-http proxy and a malformed one', () => {
    expect(() => buildHttpxArgs({ ...base, proxyUrl: 'socks5://x:1' })).toThrow(ToolError);
    expect(() => buildHttpxArgs({ ...base, proxyUrl: 'nope' })).toThrow();
  });
});

describe('probeHttp', () => {
  it('turns a live probe into service, endpoint and technology nodes with versions', async () => {
    const { ctx, run, writes } = setup([line(live)]);
    const metrics = createHttpxMetrics();
    const result = await probeHttp({ ...ctx, metrics }, ['https://app.lab.example']);
    expect(run.mock.calls[0]?.[1]).toBe('https://app.lab.example\n');
    const [write] = writes;
    const types = write?.nodes.map((n) => n.type);
    expect(types).toEqual([
      'host',
      'service',
      'endpoint',
      'technology',
      'technology',
      'technology',
    ]);
    expect(write?.nodes).toContainEqual(
      expect.objectContaining({
        type: 'endpoint',
        method: 'GET',
        url: 'https://app.lab.example:443/',
      }),
    );
    expect(write?.nodes).toContainEqual(
      expect.objectContaining({ type: 'technology', product: 'Nginx', version: '1.18.0' }),
    );
    // The Server header's nginx/1.18.0 is the same product as Nginx:1.18.0: one node.
    expect(write?.nodes.filter((n) => n.type === 'technology')).toHaveLength(3);
    expect(write?.edges.map((e) => e.type)).toEqual(['exposes', 'serves', 'runs', 'runs', 'runs']);
    expect(write?.provenance).toMatchObject({ persona: 'active-recon', tool: 'httpx' });
    const [endpoint] = result.endpoints;
    expect(endpoint).toMatchObject({
      status: 200,
      title: 'Welcome',
      server: 'nginx/1.18.0 (Ubuntu)',
    });
    expect(await metrics.registry.metrics()).toMatch(/recon_http_endpoints_total 1/);
    expect(await metrics.registry.metrics()).toMatch(/recon_tech_total 3/);
  });

  it('keeps no secret header values and no certificate material', async () => {
    const { ctx } = setup([line(live)]);
    const { endpoints } = await probeHttp(ctx, ['https://app.lab.example']);
    expect(endpoints[0]?.headers).toEqual({ server: 'nginx/1.18.0', etag: '"1"' });
    expect(endpoints[0]?.tls).toEqual({
      version: 'tls13',
      self_signed: true,
      subject_cn: 'app.lab.example',
    });
    expect(JSON.stringify(endpoints)).not.toMatch(/sid=abc|SECRET/);
  });

  it('self-signed TLS is metadata, a failed probe is skipped not written', async () => {
    const { ctx, writes } = setup([
      `${line(live)}\n${line({ url: 'https://dead.lab.example', input: 'https://dead.lab.example', failed: true })}\nnot json\n`,
    ]);
    const result = await probeHttp(ctx, ['https://app.lab.example', 'https://dead.lab.example']);
    expect(result.endpoints).toHaveLength(1);
    expect(result.skipped).toEqual([{ url: 'https://dead.lab.example', reason: 'probe_failed' }]);
    expect(writes).toHaveLength(1);
  });

  it('never sends out-of-scope or invalid targets to httpx', async () => {
    const { ctx, run } = setup([line(live)]);
    const result = await probeHttp(ctx, [
      'https://app.lab.example',
      'https://evil.example/',
      'ftp://app.lab.example',
      '-oX /tmp/x',
    ]);
    expect(run.mock.calls[0]?.[1]).toBe('https://app.lab.example\n');
    expect(result.skipped).toEqual([
      { url: 'https://evil.example/', reason: 'out_of_scope' },
      { url: 'ftp://app.lab.example', reason: 'invalid_url' },
      { url: '-oX /tmp/x', reason: 'invalid_url' },
    ]);
  });

  it('does not run httpx at all when every target is out of scope', async () => {
    const { ctx, run, writes } = setup([]);
    const result = await probeHttp(ctx, ['https://evil.example/']);
    expect(run).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(result.endpoints).toEqual([]);
  });

  it('records an out-of-scope redirect, does not write its destination, keeps the redirect status', async () => {
    const row = {
      ...live,
      status_code: 200,
      final_url: 'https://evil.example/',
      chain: [
        {
          'request-url': 'https://app.lab.example',
          status_code: 302,
          location: 'https://evil.example/',
        },
      ],
    };
    const { ctx, writes } = setup([line(row)]);
    const { endpoints } = await probeHttp(ctx, ['https://app.lab.example']);
    expect(endpoints[0]?.redirects).toEqual({
      chain: ['https://app.lab.example', 'https://evil.example/'],
      blockedAt: 'https://evil.example/',
      loop: false,
    });
    expect(endpoints[0]?.status).toBe(302);
    const urls = writes.flatMap((w) => w.nodes).flatMap((n) => ('url' in n ? [n.url] : []));
    expect(urls).toEqual(['https://app.lab.example:443/']);
  });

  it('records an in-scope redirect chain with a relative location', async () => {
    const row = {
      ...live,
      final_url: 'https://app.lab.example/home',
      chain: [{ 'request-url': 'https://app.lab.example', status_code: 301, location: '/home' }],
    };
    const { ctx } = setup([line(row)]);
    const { endpoints } = await probeHttp(ctx, ['https://app.lab.example']);
    expect(endpoints[0]?.redirects).toEqual({
      chain: ['https://app.lab.example', 'https://app.lab.example/home'],
      blockedAt: null,
      loop: false,
    });
    expect(endpoints[0]?.status).toBe(200);
  });

  it('flags a redirect loop and a chain past the cap', async () => {
    const hop = (u: string, l: string): Record<string, unknown> => ({
      'request-url': u,
      status_code: 302,
      location: l,
    });
    const a = 'https://app.lab.example/a';
    const b = 'https://app.lab.example/b';
    const looping = { ...live, chain: [hop(a, b), hop(b, a), hop(a, b)] };
    const long = {
      ...live,
      url: 'https://x.lab.example',
      input: 'https://x.lab.example',
      chain: Array.from({ length: 6 }, (_v, i) =>
        hop(`https://x.lab.example/${i}a`, `https://x.lab.example/${i}b`),
      ),
    };
    const { ctx } = setup([`${line(looping)}\n${line(long)}`]);
    const { endpoints } = await probeHttp(ctx, [
      'https://app.lab.example',
      'https://x.lab.example',
    ]);
    expect(endpoints.map((e) => e.redirects.loop)).toEqual([true, true]);
  });

  it('truncation: flags a body over the read cap', async () => {
    const { ctx } = setup([line({ ...live, content_length: 5_000_000 })]);
    const { endpoints } = await probeHttp(ctx, ['https://app.lab.example']);
    expect(endpoints[0]?.bodyTruncated).toBe(true);
  });

  it('backs off on 429 inside the budget and keeps the retried answer', async () => {
    const limited = line({ ...live, status_code: 429, header: { 'retry-after': '2' } });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { ctx, run } = setup([limited, line(live)], { sleep });
    const { endpoints } = await probeHttp(ctx, ['https://app.lab.example']);
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(endpoints[0]?.status).toBe(200);
  });

  it('stops retrying 429 at the retry cap and when the wait would pass the budget', async () => {
    const limited = line({ ...live, status_code: 429 });
    const capped = setup([limited, limited, limited, limited]);
    const a = await probeHttp(capped.ctx, ['https://app.lab.example']);
    expect(capped.run).toHaveBeenCalledTimes(3);
    expect(a.endpoints[0]?.status).toBe(429);

    let clock = 0;
    const tight = setup([limited, limited], { budgetMs: 500, now: () => clock });
    clock = 0;
    await probeHttp(tight.ctx, ['https://app.lab.example']);
    expect(tight.run).toHaveBeenCalledTimes(1);
  });

  it('fails with TOOL_BUDGET_EXCEEDED when no budget is left and TOOL_KILLED when aborted', async () => {
    await expect(
      probeHttp(setup([], { budgetMs: 0 }).ctx, ['https://app.lab.example']),
    ).rejects.toMatchObject({ code: 'TOOL_BUDGET_EXCEEDED' });
    const ac = new AbortController();
    ac.abort();
    await expect(
      probeHttp(setup([], { signal: ac.signal }).ctx, ['https://app.lab.example']),
    ).rejects.toMatchObject({ code: 'TOOL_KILLED' });
  });

  it('rejects empty and oversized target lists', async () => {
    await expect(probeHttp(setup([]).ctx, [])).rejects.toMatchObject({
      code: 'TOOL_INVALID_INPUT',
    });
    const many = Array.from({ length: 1001 }, (_v, i) => `https://h${i}.lab.example`);
    await expect(probeHttp(setup([]).ctx, many)).rejects.toMatchObject({
      code: 'TOOL_INVALID_INPUT',
    });
  });

  it('de-duplicates targets and repeated surface keys across probes', async () => {
    const { ctx, run, writes } = setup([line(live), line(live)]);
    await probeHttp(ctx, ['https://app.lab.example', 'https://app.lab.example/']);
    await probeHttp(ctx, ['https://app.lab.example']);
    expect(run.mock.calls[0]?.[1]).toBe('https://app.lab.example\nhttps://app.lab.example/\n');
    expect(writes[0]?.nodes).toEqual(writes[1]?.nodes);
  });

  it('writes large probes in several bounded batches', async () => {
    const rows = Array.from({ length: 130 }, (_v, i) =>
      line({
        url: `https://h${i}.lab.example`,
        input: `https://h${i}.lab.example`,
        status_code: 200,
      }),
    );
    const { ctx, writes } = setup([rows.join('\n')]);
    const result = await probeHttp(
      ctx,
      rows.map((_r, i) => `https://h${i}.lab.example`),
    );
    expect(writes.length).toBe(2);
    expect(writes.every((w) => w.nodes.length <= 500)).toBe(true);
    expect(result.endpoints).toHaveLength(130);
  });
});

describe('spawnHttpx', () => {
  it('feeds stdin and returns stdout from the binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'httpx-'));
    const bin = join(dir, 'fake-httpx');
    writeFileSync(bin, '#!/bin/sh\ncat\n');
    chmodSync(bin, 0o755);
    const out = await spawnHttpx(bin)(['-json'], 'a\nb\n', new AbortController().signal);
    expect(out).toBe('a\nb\n');
  });
  it('maps a missing binary to TOOL_BACKEND_UNAVAILABLE and an abort to TOOL_KILLED', async () => {
    await expect(
      spawnHttpx('/nonexistent/httpx')([], '', new AbortController().signal),
    ).rejects.toMatchObject({ code: 'TOOL_BACKEND_UNAVAILABLE' });
    const ac = new AbortController();
    ac.abort();
    await expect(spawnHttpx('/bin/sleep')(['5'], '', ac.signal)).rejects.toMatchObject({
      code: 'TOOL_KILLED',
    });
  });
});
