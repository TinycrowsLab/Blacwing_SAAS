import { describe, expect, it } from 'vitest';

import { DnsResolverUnavailableError, observeDnsTxt } from './observe.js';

import type { DnsResolver } from './resolver.js';

const NAME = '_blackwing-challenge.portal.example.com';
const TOKEN = 'blackwing-site-verification=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS';
const SETTINGS = { retries: 2, maxRecords: 50 } as const;

function dnsError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

/** A scripted resolver: each query answers from its queue, or throws the next queued error code. */
interface Script {
  txt?: (string[][] | string)[];
  cname?: Record<string, string[] | string>;
}

function scriptedResolver(script: Script): DnsResolver & { txtCalls: number; cnameCalls: number } {
  const txtQueue = [...(script.txt ?? [])];
  const cnameMap = script.cname ?? {};
  const resolver = {
    txtCalls: 0,
    cnameCalls: 0,
    resolveTxt(): Promise<string[][]> {
      resolver.txtCalls += 1;
      const next = txtQueue.shift();
      if (next === undefined) return Promise.reject(dnsError('ENODATA'));
      if (typeof next === 'string') return Promise.reject(dnsError(next));
      return Promise.resolve(next);
    },
    resolveCname(name: string): Promise<string[]> {
      resolver.cnameCalls += 1;
      const answer = cnameMap[name];
      if (answer === undefined) return Promise.reject(dnsError('ENODATA'));
      if (typeof answer === 'string') return Promise.reject(dnsError(answer));
      return Promise.resolve(answer);
    },
  };
  return resolver;
}

function observe(resolver: DnsResolver, extra: Partial<Parameters<typeof observeDnsTxt>[0]> = {}) {
  return observeDnsTxt({
    name: NAME,
    token: TOKEN,
    resolver,
    resolverLabel: '1.1.1.1,9.9.9.9',
    settings: SETTINGS,
    ...extra,
  });
}

describe('observeDnsTxt', () => {
  it('passes when the exact token is published at the derived name', async () => {
    const resolver = scriptedResolver({ txt: [[[TOKEN]]] });
    const result = await observe(resolver);
    expect(result).toMatchObject({
      matched: true,
      observedValues: [TOKEN],
      truncated: false,
      chain: [NAME],
      resolver: '1.1.1.1,9.9.9.9',
    });
    expect(resolver.txtCalls).toBe(1);
  });

  it('scans every TXT record and passes when one of many matches', async () => {
    const resolver = scriptedResolver({
      txt: [[['v=spf1 -all'], ['google-site-verification=abc'], [TOKEN]]],
    });
    expect((await observe(resolver)).matched).toBe(true);
  });

  it('joins a record made of several character-strings before it is compared', async () => {
    const half = Math.floor(TOKEN.length / 2);
    const resolver = scriptedResolver({ txt: [[[TOKEN.slice(0, half), TOKEN.slice(half)]]] });
    expect((await observe(resolver)).matched).toBe(true);
  });

  it('is a clean no-match on NXDOMAIN, without a retry', async () => {
    const resolver = scriptedResolver({ txt: ['ENOTFOUND'] });
    const result = await observe(resolver);
    expect(result).toMatchObject({ matched: false, observedValues: [] });
    expect(resolver.txtCalls).toBe(1);
  });

  it('is a clean no-match when the name exists without TXT records (ENODATA), without a retry', async () => {
    const resolver = scriptedResolver({ txt: ['ENODATA'] });
    expect((await observe(resolver)).matched).toBe(false);
    expect(resolver.txtCalls).toBe(1);
  });

  it('is a clean no-match for a wrong value', async () => {
    const resolver = scriptedResolver({ txt: [[['blackwing-site-verification=WRONG']]] });
    expect((await observe(resolver)).matched).toBe(false);
  });

  it('retries a resolver timeout and passes on the attempt that answers (fault injection)', async () => {
    const resolver = scriptedResolver({ txt: ['ETIMEOUT', 'ESERVFAIL', [[TOKEN]]] });
    const result = await observe(resolver);
    expect(result.matched).toBe(true);
    expect(resolver.txtCalls).toBe(3);
  });

  it('gives up after retries+1 attempts with a retryable error, never a miss', async () => {
    const resolver = scriptedResolver({ txt: ['ETIMEOUT', 'ETIMEOUT', 'ETIMEOUT', [[TOKEN]]] });
    const error = await observe(resolver).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DnsResolverUnavailableError);
    expect(error).toMatchObject({ code: 'ETIMEOUT' });
    expect(resolver.txtCalls).toBe(3);
  });

  it('treats SERVFAIL as a resolver failure, not a miss', async () => {
    const resolver = scriptedResolver({ txt: ['ESERVFAIL', 'ESERVFAIL', 'ESERVFAIL'] });
    await expect(observe(resolver)).rejects.toBeInstanceOf(DnsResolverUnavailableError);
  });

  it('records a CNAME chain in order', async () => {
    const resolver = scriptedResolver({
      cname: { [NAME]: ['edge.example.net'], 'edge.example.net': ['origin.example.org'] },
      txt: [[[TOKEN]]],
    });
    expect((await observe(resolver)).chain).toEqual([
      NAME,
      'edge.example.net',
      'origin.example.org',
    ]);
  });

  it('stops following a CNAME loop instead of walking it forever', async () => {
    const resolver = scriptedResolver({
      cname: { [NAME]: ['a.example.net'], 'a.example.net': [NAME] },
      txt: [[[TOKEN]]],
    });
    expect((await observe(resolver)).chain).toEqual([NAME, 'a.example.net']);
  });

  it('cuts a CNAME chain at the hop cap', async () => {
    const cname: Record<string, string[]> = {};
    let previous = NAME;
    for (let hop = 0; hop < 20; hop++) {
      const next = `hop${hop}.example.net`;
      cname[previous] = [next];
      previous = next;
    }
    const result = await observe(scriptedResolver({ cname, txt: [[[TOKEN]]] }));
    expect(result.chain).toHaveLength(9);
  });

  it('considers at most maxRecords values and reports the cut', async () => {
    const many = Array.from({ length: 60 }, (_, index) => [`filler-${index}`]);
    const resolver = scriptedResolver({ txt: [[...many, [TOKEN]]] });
    const result = await observe(resolver, { settings: { retries: 2, maxRecords: 50 } });
    expect(result.observedValues).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(result.matched).toBe(false);
  });

  it('handles case and surrounding whitespace in the published value (named test)', async () => {
    const resolver = scriptedResolver({ txt: [[[`  ${TOKEN.toUpperCase()}  `]]] });
    expect((await observe(resolver)).matched).toBe(true);
  });

  it('reports elapsed time from the injected clock', async () => {
    const ticks = [100, 142];
    const result = await observe(scriptedResolver({ txt: [[[TOKEN]]] }), {
      now: () => ticks.shift() ?? 142,
    });
    expect(result.elapsedMs).toBe(42);
  });

  it('does not start a lookup once the activity is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const resolver = scriptedResolver({ txt: [[[TOKEN]]] });
    await expect(observe(resolver, { signal: controller.signal })).rejects.toThrow();
    expect(resolver.txtCalls).toBe(0);
  });

  it('ends at once when cancelled during a lookup, instead of retrying it as an outage', async () => {
    const controller = new AbortController();
    const resolver: DnsResolver = {
      resolveTxt: () => {
        controller.abort();
        return Promise.reject(dnsError('ETIMEOUT'));
      },
      resolveCname: () => Promise.reject(dnsError('ENODATA')),
    };
    const error = await observe(resolver, { signal: controller.signal }).catch(
      (caught: unknown) => caught,
    );
    expect(error).not.toBeInstanceOf(DnsResolverUnavailableError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});
