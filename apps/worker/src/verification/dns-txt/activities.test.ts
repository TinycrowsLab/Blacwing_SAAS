import { describe, expect, it } from 'vitest';

import {
  createVerificationDnsActivities,
  type DnsChallenge,
  type DnsProbeOutcome,
  type VerificationDnsStore,
} from './activities.js';
import { DnsResolverUnavailableError } from './observe.js';

import type { DnsResolver } from './resolver.js';

const NOW = new Date('2026-10-30T10:00:00.000Z');
const LATER = new Date('2026-11-02T10:00:00.000Z');
const NAME = '_blackwing-challenge.portal.example.com';
const TOKEN = 'blackwing-site-verification=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRS';
const TENANT = '0190f2a0-0000-7000-8000-000000000001';
const CHALLENGE_ID = '0190f2a0-0000-7000-8000-000000000002';

function dnsError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function challenge(overrides: Partial<DnsChallenge> = {}): DnsChallenge {
  return {
    challengeId: CHALLENGE_ID,
    assetId: '0190f2a0-0000-7000-8000-000000000003',
    method: 'dns_txt',
    token: TOKEN,
    expectedLocation: NAME,
    status: 'pending',
    expiresAt: LATER,
    ...overrides,
  };
}

interface FakeStore extends VerificationDnsStore {
  applied: { tenantId: string; challengeId: string; matched: boolean; at: Date }[];
}

function fakeStore(
  current: DnsChallenge | undefined,
  outcome: DnsProbeOutcome = 'passed',
): FakeStore {
  const store: FakeStore = {
    applied: [],
    load: (tenantId) => {
      expect(tenantId).toBe(TENANT);
      return Promise.resolve(current);
    },
    apply: (input) => {
      store.applied.push(input);
      return Promise.resolve(outcome);
    },
  };
  return store;
}

function fakeResolver(answers: (string[][] | string)[]): DnsResolver & { txtCalls: number } {
  const queue = [...answers];
  const resolver = {
    txtCalls: 0,
    resolveTxt(): Promise<string[][]> {
      resolver.txtCalls += 1;
      const next = queue.shift();
      if (next === undefined) return Promise.reject(dnsError('ENODATA'));
      if (typeof next === 'string') return Promise.reject(dnsError(next));
      return Promise.resolve(next);
    },
    resolveCname: () => Promise.reject(dnsError('ENODATA')),
  };
  return resolver;
}

function build(options: {
  store: VerificationDnsStore;
  resolver: DnsResolver;
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  result?: (value: string) => void;
}) {
  const logLines: unknown[] = [];
  const log = options.log ?? {
    info: (...args: unknown[]) => logLines.push(args),
    warn: (...args: unknown[]) => logLines.push(args),
  };
  const results: string[] = [];
  const activities = createVerificationDnsActivities({
    store: options.store,
    resolver: options.resolver,
    resolverLabel: '1.1.1.1,9.9.9.9',
    settings: { timeoutMs: 5_000, retries: 2, maxRecords: 50 },
    metrics: { result: (value) => results.push(value) },
    log,
    now: () => NOW,
    cancellation: () => new AbortController().signal,
  });
  return { activities, logLines, results };
}

const INPUT = { tenantId: TENANT, challengeId: CHALLENGE_ID };

describe('verifyDnsTxtActivity skips without probing', () => {
  it.each([
    ['not_found', undefined],
    ['not_pending', challenge({ status: 'passed' })],
    ['not_dns', challenge({ method: 'http_file' })],
    ['no_location', challenge({ expectedLocation: null })],
    ['expired', challenge({ expiresAt: NOW })],
  ] as const)('skips %s and makes no DNS query', async (reason, current) => {
    const resolver = fakeResolver([[[TOKEN]]]);
    const store = fakeStore(current);
    const { activities } = build({ store, resolver });
    expect(await activities.verifyDnsTxtActivity(INPUT)).toEqual({ status: 'skipped', reason });
    expect(resolver.txtCalls).toBe(0);
    expect(store.applied).toEqual([]);
  });
});

describe('verifyDnsTxtActivity', () => {
  it('passes a challenge whose token is published, and returns the observation', async () => {
    const resolver = fakeResolver([[[TOKEN]]]);
    const store = fakeStore(challenge(), 'passed');
    const { activities, results } = build({ store, resolver });

    const result = await activities.verifyDnsTxtActivity(INPUT);

    expect(result).toMatchObject({
      status: 'checked',
      outcome: 'passed',
      matched: true,
      observedValues: [TOKEN],
      truncated: false,
      chain: [NAME],
      resolver: '1.1.1.1,9.9.9.9',
    });
    expect(store.applied).toEqual([
      { tenantId: TENANT, challengeId: CHALLENGE_ID, matched: true, at: NOW },
    ]);
    expect(results).toEqual(['passed']);
  });

  it('feeds a clean miss to the state machine as a failed probe (no record)', async () => {
    const store = fakeStore(challenge(), 'retry');
    const { activities, results } = build({ store, resolver: fakeResolver(['ENOTFOUND']) });

    const result = await activities.verifyDnsTxtActivity(INPUT);

    expect(result).toMatchObject({ status: 'checked', outcome: 'retry', matched: false });
    expect(store.applied).toEqual([expect.objectContaining({ matched: false })]);
    expect(results).toEqual(['not_found']);
  });

  it('does not change the challenge on a resolver outage: the error is retryable and nothing is applied', async () => {
    const store = fakeStore(challenge());
    const { activities, results } = build({
      store,
      resolver: fakeResolver(['ETIMEOUT', 'ETIMEOUT', 'ETIMEOUT']),
    });

    await expect(activities.verifyDnsTxtActivity(INPUT)).rejects.toBeInstanceOf(
      DnsResolverUnavailableError,
    );
    expect(store.applied).toEqual([]);
    expect(results).toEqual(['resolver_error']);
  });

  it('is retried by Temporal: a second run after an outage answers and passes (fault injection)', async () => {
    const store = fakeStore(challenge(), 'passed');
    const resolver = fakeResolver(['ETIMEOUT', 'ETIMEOUT', 'ETIMEOUT', [[TOKEN]]]);
    const { activities } = build({ store, resolver });

    await expect(activities.verifyDnsTxtActivity(INPUT)).rejects.toBeInstanceOf(
      DnsResolverUnavailableError,
    );
    const retried = await activities.verifyDnsTxtActivity(INPUT);
    expect(retried).toMatchObject({ status: 'checked', matched: true, outcome: 'passed' });
    expect(store.applied).toHaveLength(1);
  });

  it('never writes the token or the observed values into logs', async () => {
    const { activities, logLines } = build({
      store: fakeStore(challenge(), 'passed'),
      resolver: fakeResolver([[[TOKEN]]]),
    });

    await activities.verifyDnsTxtActivity(INPUT);

    expect(JSON.stringify(logLines)).not.toContain(TOKEN);
    expect(JSON.stringify(logLines)).toContain(NAME);
  });
});
