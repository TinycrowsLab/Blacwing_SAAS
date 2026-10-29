// DEMO-STORY unit tests: the deterministic oracle, the scope guard and the replay outcome (no network).
import { describe, expect, it } from 'vitest';

import {
  assertInScope,
  BudgetExhausted,
  errorSignatureMatches,
  probeUrl,
  runPinnedCase,
  ScopeRefusal,
  type ObservedResponse,
  type ReplayPins,
  type StageEvent,
} from './replay.js';

const PINS: ReplayPins = {
  asset: {
    id: '0197a5d0-0000-7000-8000-00000000a001',
    baseUrl: 'http://127.0.0.1:3001',
    name: 'lab',
  },
  scope: { method: 'GET', host: '127.0.0.1', pathPrefix: '/rest/products/search', parameter: 'q' },
  testCase: {
    id: 'webapi.injection.sql',
    title: 'SQL injection in product search',
    cwe: 'CWE-89',
    owasp: 'A03:2021-Injection',
    wstg: 'WSTG-INPV-05',
    probe: { value: "apple'", label: 'probe' },
    negativeControl: { value: 'apple', label: 'control' },
    oracle: {
      id: 'oracle.webapi.injection.sql.error_signature.v1',
      type: 'error_signature',
      params: { signature: 'SQLITE_ERROR' },
    },
    replayCount: 2,
  },
};

const ERROR_BODY = '<title>Error: SQLITE_ERROR: near &quot;&#39;%&#39;&quot;: syntax error</title>';
const OK_BODY = '{"status":"success","data":[{"name":"Apple Juice"}]}';

function fakeFetch(respond: (url: string) => ObservedResponse) {
  const seen: string[] = [];
  return {
    seen,
    fetch: (url: string): Promise<ObservedResponse> => {
      seen.push(url);
      return Promise.resolve(respond(url));
    },
  };
}

const quietDeps = (
  fetch: (url: string) => Promise<ObservedResponse>,
  events: StageEvent[],
  budget = 8,
) => ({
  fetch,
  sleep: () => Promise.resolve(),
  stageDelayMs: 0,
  budgetRequests: budget,
  emit: (event: StageEvent) => {
    events.push(event);
    return Promise.resolve();
  },
});

describe('errorSignatureMatches (deterministic oracle)', () => {
  it('matches the signature in the body, regardless of status', () => {
    expect(
      errorSignatureMatches(
        { status: 500, contentType: 'text/html', body: ERROR_BODY },
        'SQLITE_ERROR',
      ),
    ).toBe(true);
  });
  it('does not match an ordinary response', () => {
    expect(
      errorSignatureMatches(
        { status: 200, contentType: 'application/json', body: OK_BODY },
        'SQLITE_ERROR',
      ),
    ).toBe(false);
  });
  it('never matches an empty signature', () => {
    expect(errorSignatureMatches({ status: 200, contentType: '', body: 'anything' }, '')).toBe(
      false,
    );
  });
});

describe('probeUrl and scope', () => {
  it('encodes the single quote as %27 so the repro works in a shell', () => {
    expect(probeUrl(PINS.asset.baseUrl, PINS, "apple'")).toBe(
      'http://127.0.0.1:3001/rest/products/search?q=apple%27',
    );
  });
  it('refuses a host, a path or a method outside the scope', () => {
    expect(() => {
      assertInScope('http://example.com/rest/products/search?q=a', PINS);
    }).toThrow(ScopeRefusal);
    expect(() => {
      assertInScope('http://127.0.0.1:3001/api/Users', PINS);
    }).toThrow(ScopeRefusal);
    expect(() => {
      assertInScope('http://127.0.0.1:3001/rest/products/search?q=a', {
        ...PINS,
        scope: { ...PINS.scope, method: 'POST' },
      });
    }).toThrow(ScopeRefusal);
  });
});

describe('runPinnedCase', () => {
  it('confirms when both replays match and the negative control does not', async () => {
    const events: StageEvent[] = [];
    const { fetch, seen } = fakeFetch((url) =>
      url.endsWith('%27')
        ? { status: 500, contentType: 'text/html', body: ERROR_BODY }
        : { status: 200, contentType: 'application/json', body: OK_BODY },
    );
    const outcome = await runPinnedCase(PINS, 'run-1', quietDeps(fetch, events));
    expect(outcome.confirmed).toBe(true);
    expect(outcome.requestsUsed).toBe(4);
    expect(seen).toHaveLength(4);
    expect(outcome.replays.every((r) => r.matched)).toBe(true);
    expect(outcome.negativeControl.matched).toBe(false);
    expect(events.map((e) => e.kind)).toContain('oracle.replayed');
  });

  it('does not confirm when the negative control also matches', async () => {
    const events: StageEvent[] = [];
    const { fetch } = fakeFetch(() => ({
      status: 500,
      contentType: 'text/html',
      body: ERROR_BODY,
    }));
    const outcome = await runPinnedCase(PINS, 'run-2', quietDeps(fetch, events));
    expect(outcome.confirmed).toBe(false);
  });

  it('stops at the request budget (fail closed)', async () => {
    const events: StageEvent[] = [];
    const { fetch } = fakeFetch(() => ({ status: 200, contentType: '', body: OK_BODY }));
    await expect(runPinnedCase(PINS, 'run-3', quietDeps(fetch, events, 2))).rejects.toBeInstanceOf(
      BudgetExhausted,
    );
  });
});
