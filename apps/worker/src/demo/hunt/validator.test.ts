import { describe, expect, it } from 'vitest';

import { buildEvidence, oracleMatches, reproCurl, validateCandidate, type Candidate } from './validator.js';

import type { HttpRequest, HttpResult } from './http-tool.js';

const ok = (body: string, status = 200, headers: Record<string, string> = {}): HttpResult => ({ ok: true, exchangeId: 'x', status, headers, body, bodyBytes: body.length });

const candidate: Candidate = {
  title: 'Reflected marker',
  vulnClass: 'xss.reflected',
  cwe: 'CWE-79',
  owasp: 'A03:2021',
  severity: 'medium',
  description: 'The q parameter is reflected unescaped.',
  probe: { method: 'GET', url: 'https://t.example/search?q=bwmark' },
  control: { method: 'GET', url: 'https://t.example/search?q=plain' },
  oracle: { type: 'body_contains', value: 'bwmark' },
};

function hooks(respond: (request: HttpRequest, call: number) => HttpResult) {
  const calls: HttpRequest[] = [];
  const steps: string[] = [];
  return {
    calls,
    steps,
    hooks: {
      send: (request: HttpRequest) => {
        calls.push(request);
        return Promise.resolve(respond(request, calls.length));
      },
      replay: (n: number, _status: number, matched: boolean) => {
        steps.push(`replay${n}:${matched}`);
        return Promise.resolve();
      },
      control: (_status: number, matched: boolean) => {
        steps.push(`control:${matched}`);
        return Promise.resolve();
      },
    },
  };
}

describe('oracleMatches', () => {
  const response = { status: 500, headers: { 'X-Powered-By': 'Express' }, body: 'SQLITE_ERROR near "\'"' };
  it('evaluates every oracle type', () => {
    expect(oracleMatches({ type: 'body_contains', value: 'SQLITE_ERROR' }, response)).toBe(true);
    expect(oracleMatches({ type: 'body_regex', value: 'near "."' }, response)).toBe(true);
    expect(oracleMatches({ type: 'status_equals', value: '500' }, response)).toBe(true);
    expect(oracleMatches({ type: 'status_equals', value: '200' }, response)).toBe(false);
    expect(oracleMatches({ type: 'header_contains', value: 'x-powered-by: express' }, response)).toBe(true);
    expect(oracleMatches({ type: 'header_contains', value: 'server: express' }, response)).toBe(false);
  });
  it('treats an invalid regex as no match', () => {
    expect(oracleMatches({ type: 'body_regex', value: '(' }, response)).toBe(false);
  });
});

describe('validateCandidate', () => {
  it('confirms only when 3 probe replays match and the control does not', async () => {
    const h = hooks((request) => ok(request.url.includes('bwmark') ? 'found bwmark here' : 'nothing'));
    const verdict = await validateCandidate(candidate, h.hooks);
    expect(verdict.confirmed).toBe(true);
    expect(h.calls).toHaveLength(4);
    expect(h.steps).toEqual(['replay1:true', 'replay2:true', 'replay3:true', 'control:false']);
  });

  it('does not confirm when the negative control also matches', async () => {
    const verdict = await validateCandidate(candidate, hooks(() => ok('bwmark')).hooks);
    expect(verdict).toMatchObject({ confirmed: false, controlMatched: true });
  });

  it('does not confirm a flaky probe and stops replaying', async () => {
    const h = hooks((_request, call) => ok(call === 2 ? 'nothing' : 'bwmark'));
    const verdict = await validateCandidate(candidate, h.hooks);
    expect(verdict.confirmed).toBe(false);
    expect(h.calls).toHaveLength(2);
  });

  it('does not confirm when a request is refused', async () => {
    const refused = hooks(() => ({ ok: false, refusal: 'Refused by policy (gate2_required)' }));
    expect((await validateCandidate(candidate, refused.hooks)).confirmed).toBe(false);
    const controlRefused = hooks((request) => (request.url.includes('plain') ? { ok: false, refusal: 'no' } : ok('bwmark')));
    expect((await validateCandidate(candidate, controlRefused.hooks)).confirmed).toBe(false);
  });
});

describe('evidence', () => {
  it('builds the spec evidence shape and a quoted repro command', async () => {
    const verdict = await validateCandidate(candidate, hooks((request) => ok(request.url.includes('bwmark') ? 'bwmark' : 'x')).hooks);
    if (verdict.probe === null || verdict.control === null) throw new Error('expected responses');
    const evidence = buildEvidence(candidate, verdict.probe, verdict.control, verdict.replays);
    expect(Object.keys(evidence).sort()).toEqual(['control', 'description', 'oracle', 'probe', 'replays']);
    expect(reproCurl({ method: 'post', url: "https://t.example/a'b", headers: { 'X-A': "it's" }, body: '{"a":1}' })).toBe(
      `curl -sS -i -X POST -H 'X-A: it'\\''s' --data-raw '{"a":1}' 'https://t.example/a'\\''b'`,
    );
  });
});
