import { describe, expect, it } from 'vitest';

import {
  buildFindingRow,
  canonicalOwasp,
  candidateSchema,
  controlDelta,
  templateRefusal,
  identityKey,
  normalisedPath,
  oracleMatches,
  replayableRequest,
  reproCurl,
  retestFinding,
  validateCandidate,
  type Candidate,
  type Verdict,
} from './validator.js';

import type { HttpRequest, HttpResult } from './http-tool.js';
import type { RetestJob } from './types.js';

// A structurally valid, unsigned sample token (benign lab value).
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MSwicm9sZSI6ImFkbWluIn0.c2lnbmF0dXJlLXNhbXBsZQ';

const sentOf = (request: HttpRequest) => ({
  method: request.method.toUpperCase(),
  url: request.url,
  headers: { 'user-agent': 'blackwing-hunt/1', ...(request.as_role === undefined ? {} : { authorization: `[redacted: role ${request.as_role}]` }) },
  body: request.body ?? null,
  asRole: request.as_role ?? null,
});

const ok = (request: HttpRequest, body: string, status = 200, headers: Record<string, string> = {}): HttpResult => ({
  ok: true,
  exchangeId: `x-${request.url}`,
  status,
  headers,
  body,
  bodyBytes: body.length,
  request: sentOf(request),
});

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

const reflect = (request: HttpRequest) => ok(request, request.url.includes('bwmark') ? 'found bwmark here' : 'nothing');

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

describe('controlDelta', () => {
  const base = { method: 'GET', url: 'https://t.example/rest/basket/2' };
  it.each([
    [{ ...base, url: 'https://t.example/rest/basket/2?x=1' }, 'query'],
    [{ ...base, body: 'a=1' }, 'body'],
    [{ ...base, headers: { 'X-Test': '1' } }, 'header'],
    [{ ...base, as_role: 'bob' }, 'role'],
    [{ ...base, url: 'https://t.example/rest/basket/1' }, 'path_segment'],
  ])('accepts exactly one changed part (%#: %s)', (control, delta) => {
    expect(controlDelta(base, control)).toEqual({ ok: true, delta });
  });

  it('ignores header name case and order', () => {
    expect(controlDelta({ ...base, headers: { A: '1', b: '2' } }, { ...base, headers: { B: '2', a: '1' }, as_role: 'x' })).toEqual({ ok: true, delta: 'role' });
  });

  it.each([
    [{ ...base, url: 'https://t.example/metrics' }, 'path'],
    [{ ...base, method: 'POST' }, 'method'],
    [{ ...base, url: 'https://other.example/rest/basket/2' }, 'origin'],
    [{ ...base, url: 'https://t.example/rest/basket/1?x=1' }, 'path_segment, query'],
    [base, 'nothing (the control is the probe)'],
  ])('refuses any other control (%#: %s)', (control, differs) => {
    expect(controlDelta(base, control)).toEqual({ ok: false, differs });
  });
});

describe('validateCandidate', () => {
  it('confirms only when 3 probe replays match and the control does not', async () => {
    const h = hooks(reflect);
    const verdict = await validateCandidate(candidate, h.hooks);
    expect(verdict).toMatchObject({ confirmed: true, delta: 'query' });
    expect(h.calls).toHaveLength(4);
    expect(h.steps).toEqual(['replay1:true', 'replay2:true', 'replay3:true', 'control:false']);
  });

  it('sends nothing and keeps the candidate suspected when the control is not single-delta', async () => {
    const h = hooks(reflect);
    const verdict = await validateCandidate({ ...candidate, control: { method: 'GET', url: 'https://t.example/a/b?q=bwmark' } }, h.hooks);
    expect(verdict).toMatchObject({ confirmed: false, reason: 'control_not_single_delta: path differ', delta: null });
    expect(h.calls).toHaveLength(0);
  });

  it('replays a state-changing probe once', async () => {
    const post: Candidate = {
      ...candidate,
      probe: { method: 'POST', url: 'https://t.example/login', body: "email=' OR 1=1--" },
      control: { method: 'POST', url: 'https://t.example/login', body: 'email=a' },
      oracle: { type: 'status_equals', value: '200' },
    };
    const h = hooks((request) => ok(request, '', request.body?.includes('OR') === true ? 200 : 401));
    const verdict = await validateCandidate(post, h.hooks);
    expect(verdict).toMatchObject({ confirmed: true, delta: 'body' });
    expect(h.steps).toEqual(['replay1:true', 'control:false']);
    const logout = hooks((request) => ok(request, request.url.includes('bwmark') ? 'bwmark' : ''));
    await validateCandidate({ ...candidate, probe: { method: 'GET', url: 'https://t.example/logout?q=bwmark' }, control: { method: 'GET', url: 'https://t.example/logout?q=plain' } }, logout.hooks);
    expect(logout.calls).toHaveLength(2);
  });

  it('does not confirm when the negative control also matches', async () => {
    const verdict = await validateCandidate(candidate, hooks((request) => ok(request, 'bwmark')).hooks);
    expect(verdict).toMatchObject({ confirmed: false, controlMatched: true });
  });

  it('does not confirm a flaky probe and stops replaying', async () => {
    const h = hooks((request, call) => ok(request, call === 2 ? 'nothing' : 'bwmark'));
    const verdict = await validateCandidate(candidate, h.hooks);
    expect(verdict.confirmed).toBe(false);
    expect(h.calls).toHaveLength(2);
  });

  it('does not confirm when a request is refused', async () => {
    const refused = hooks(() => ({ ok: false, refusal: 'Refused by policy (gate2_required)' }));
    expect((await validateCandidate(candidate, refused.hooks)).confirmed).toBe(false);
    const controlRefused = hooks((request) => (request.url.includes('plain') ? { ok: false, refusal: 'no' } : ok(request, 'bwmark')));
    expect((await validateCandidate(candidate, controlRefused.hooks)).confirmed).toBe(false);
  });
});

describe('OWASP canonical form', () => {
  it.each([
    ['A03:2021-Injection', 'A03:2021 Injection'],
    ['OWASP A3', 'A03:2021 Injection'],
    ['a03', 'A03:2021 Injection'],
    ['A10:2021 SSRF', 'A10:2021 Server-Side Request Forgery'],
    ['A1', 'A01:2021 Broken Access Control'],
  ])('%s -> %s', (text, canonical) => {
    expect(canonicalOwasp(text)).toBe(canonical);
  });

  it('refuses a candidate whose category is not A01..A10, naming the valid codes', () => {
    expect(canonicalOwasp('API3:2023')).toBeNull();
    const parsed = candidateSchema.safeParse({ ...candidate, owasp: 'Injection' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('A01, A02');
  });
});

describe('identity', () => {
  it('normalises the path: case, numeric and uuid segments, trailing slash', () => {
    expect(normalisedPath('https://t.example/Rest/Basket/2/')).toBe('/rest/basket/:id');
    expect(normalisedPath('https://t.example/api/users/0197a5d0-aaaa-7000-8000-000000000001?x=1')).toBe('/api/users/:id');
    expect(normalisedPath('https://t.example/')).toBe('/');
  });

  it('is stable across runs and agents and differs by asset, method, path and CWE', () => {
    const a = identityKey('asset-1', { probe: { method: 'get', url: 'https://t.example/ftp/' }, cwe: 'cwe-548' });
    expect(identityKey('asset-1', { probe: { method: 'GET', url: 'https://t.example/FTP' }, cwe: 'CWE-548' })).toBe(a);
    expect(identityKey('asset-2', { probe: { method: 'GET', url: 'https://t.example/ftp' }, cwe: 'CWE-548' })).not.toBe(a);
    expect(identityKey('asset-1', { probe: { method: 'GET', url: 'https://t.example/ftp2' }, cwe: 'CWE-548' })).not.toBe(a);
    expect(identityKey('asset-1', { probe: { method: 'GET', url: 'https://t.example/ftp' }, cwe: 'CWE-89' })).not.toBe(a);
  });

  it('strips query values, collapses slashes and folds a backup file into its family', () => {
    expect(normalisedPath('https://t.example//config///config.inc.php.bak?x=1')).toBe('/config/config.inc.php');
    expect(normalisedPath('https://t.example/config/config.inc.php~')).toBe('/config/config.inc.php');
    expect(normalisedPath('https://t.example/app/index.php?page=1')).toBe('/app');
  });

  it('merges the same issue filed under related CWEs and different titles', () => {
    const lfi = (cwe: string, url: string) => identityKey('a', { probe: { method: 'GET', url }, cwe, title: 'x' });
    expect(lfi('CWE-22', 'https://t.example/fi/?page=/etc/passwd')).toBe(lfi('CWE-98', 'https://t.example/fi/?page=../../x'));
    const bak = (cwe: string, url: string) => identityKey('a', { probe: { method: 'GET', url }, cwe });
    expect(bak('CWE-530', 'https://t.example/config/c.inc.php.bak')).toBe(bak('CWE-538', 'https://t.example/config/c.inc.php.bak'));
    expect(bak('CWE-530', 'https://t.example/config/c.inc.php.bak')).toBe(bak('CWE-538', 'https://t.example/config/c.inc.php'));
  });

  it('collapses cookie attribute issues to one per site', () => {
    const c = (url: string) => identityKey('a', { probe: { method: 'GET', url }, cwe: 'CWE-1004', title: 'cookie without HttpOnly' });
    expect(c('https://t.example/about.php')).toBe(c('https://t.example/login.php'));
  });

  it('collapses site-wide header and banner issues to one per site', () => {
    const h = (cwe: string, title: string, url: string) => identityKey('a', { probe: { method: 'GET', url }, cwe, title });
    expect(h('CWE-200', 'Server version disclosure and missing security headers', 'https://t.example/login.php')).toBe(
      h('CWE-693', 'Missing security headers and server version disclosure', 'https://t.example/'),
    );
    expect(h('CWE-200', 'Exposed backup file', 'https://t.example/a.bak')).not.toBe(h('CWE-693', 'Missing security headers', 'https://t.example/'));
  });
});

describe('buildFindingRow', () => {
  const run = { id: 'run-1', assetId: 'asset-1' };

  it('stores the proof, the trigger request as sent and scrubbed text', async () => {
    const leaky: Candidate = {
      ...candidate,
      probe: { ...candidate.probe, as_role: 'alice' },
      control: { method: 'GET', url: 'https://t.example/search?q=hello', as_role: 'alice' },
      owasp: 'A03:2021-Injection',
      description: `Found $_DVWA[ 'db_password' ] = 'vulnerables'; token ${JWT}`,
      remediation: 'Rotate "password": "pass1" now',
    };
    const verdict = await validateCandidate(leaky, hooks((request) => ok(request, request.url.includes('bwmark') ? `bwmark {"token":"${JWT}"}` : 'nothing')).hooks);
    const { proven, row } = buildFindingRow({ run, candidate: leaky, verdict, agent: 'web-api-specialist', testCaseId: 'xss-1', credentialHeader: 'Authorization' });
    expect(proven).toBe(true);
    expect(row.owasp).toBe('A03:2021 Injection');
    expect(row.location).toEqual({ method: 'GET', url: 'https://t.example/search?q=bwmark' });
    expect(row.reproCurl).toBe("curl -sS -i -X GET -H 'user-agent: blackwing-hunt/1' -H 'authorization: <alice credential>' 'https://t.example/search?q=bwmark'");
    expect(row.evidence.proof).toEqual({ kind: 'differential_replay', replays: 3, delta: 'query', proposedBy: 'claude' });
    const probe = row.evidence.probe as { exchangeId: string; request: { asRole: string }; response: { bodyExcerpt: string; bodySha256: string } };
    expect(probe.exchangeId).toBe('x-https://t.example/search?q=bwmark');
    expect(probe.request.asRole).toBe('alice');
    expect(probe.response.bodyExcerpt).toBe('bwmark {"token":"[redacted: token]"}');
    expect(probe.response.bodySha256).toBe(verdict.replays[0]?.bodySha256);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(JWT);
    expect(stored).not.toContain('vulnerables');
    expect(stored).not.toContain('pass1');
    expect(row.identityKey).toBe(identityKey('asset-1', leaky));
    expect(row.replay).toEqual({ replays: verdict.replays, control: { status: 200, matched: false } });
  });

  it('merges two agents in one run and keeps a later run separate', async () => {
    const verdict = await validateCandidate(candidate, hooks(reflect).hooks);
    const input = { candidate, verdict, testCaseId: null, credentialHeader: undefined };
    const a = buildFindingRow({ ...input, run, agent: 'recon' }).row;
    const b = buildFindingRow({ ...input, run, agent: 'web-api-specialist', candidate: { ...candidate, title: 'Other words' } }).row;
    const later = buildFindingRow({ ...input, run: { ...run, id: 'run-2' }, agent: 'recon' }).row;
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(later.fingerprint).not.toBe(a.fingerprint);
    expect(later.identityKey).toBe(a.identityKey);
  });

  it('builds a suspected row from the candidate when nothing was sent', () => {
    const verdict: Verdict = { confirmed: false, reason: 'control_not_single_delta: path differ', delta: null, replays: [], probe: null, control: null, controlMatched: null };
    const probe = { method: 'post', url: 'https://t.example/api?token=abc', body: '{"password":"x"}', as_role: 'bob' };
    const { proven, row } = buildFindingRow({ run, candidate: { ...candidate, probe }, verdict, agent: 'a', testCaseId: null, credentialHeader: 'X-Api-Key' });
    expect(proven).toBe(false);
    expect(row.evidence).toMatchObject({ reason: verdict.reason, replays: [], oracle: candidate.oracle, probe: { request: { method: 'POST', asRole: 'bob' } } });
    expect(row.reproCurl).toBe(
      `curl -sS -i -X POST -H 'x-api-key: <bob credential>' --data-raw '{"password":"[redacted: password]"}' 'https://t.example/api?token=[redacted: secret]'`,
    );
    expect(row.replay).toEqual({ replays: [], control: null });
  });
});

describe('reproCurl', () => {
  it('quotes every part', () => {
    expect(reproCurl({ method: 'post', url: "https://t.example/a'b", headers: { 'x-a': "it's" }, body: '{"a":1}', asRole: null })).toBe(
      `curl -sS -i -X POST -H 'x-a: it'\\''s' --data-raw '{"a":1}' 'https://t.example/a'\\''b'`,
    );
  });
});

describe('retest', () => {
  const run = { testAccounts: [{ role: 'alice', headerName: 'Authorization', headerValue: 'secret-value' }] } as unknown as RetestJob['run'];
  const stored = (url: string, extra: Record<string, unknown> = {}) => ({
    method: 'GET',
    url,
    headers: { 'user-agent': 'blackwing-hunt/1', authorization: '[redacted: role alice]' },
    body: null,
    asRole: 'alice',
    ...extra,
  });
  const job = (probe: unknown, control: unknown): RetestJob => ({ id: 'rt', findingId: 'f', run, probe, control, oracle: candidate.oracle });

  it('rebuilds the stored request: runner headers dropped, the credential back to as_role', () => {
    expect(replayableRequest(stored('https://t.example/search?q=bwmark'), ['alice'])).toEqual({
      request: { method: 'GET', url: 'https://t.example/search?q=bwmark', as_role: 'alice' },
    });
  });

  it('never replays a value Blackwing does not keep, nor a role no longer on the plan', () => {
    const token = stored('https://t.example/me', { headers: { authorization: `Bearer ${JWT}` }, asRole: null });
    expect(replayableRequest(token, ['alice'])).toEqual({ reason: 'The request needs a fresh sign-in: it used a value Blackwing does not keep.' });
    expect(replayableRequest(stored('https://t.example/me'), [])).toEqual({ reason: "The test account alice is no longer on this audit's plan." });
    expect(replayableRequest(undefined, [])).toEqual({ reason: 'The finding has no stored request to send again.' });
  });

  it('reports still present, fixed or inconclusive', async () => {
    const pair = job(stored('https://t.example/search?q=bwmark'), stored('https://t.example/search?q=plain'));
    const sent: HttpRequest[] = [];
    const present = await retestFinding(pair, (request) => {
      sent.push(request);
      return Promise.resolve(reflect(request));
    });
    expect(present).toMatchObject({ status: 'done', result: 'still_present', detail: { control: { status: 200, matched: false } } });
    expect(sent).toHaveLength(4);
    expect(sent.every((r) => r.as_role === 'alice' && r.headers === undefined)).toBe(true);
    expect(await retestFinding(pair, (request) => Promise.resolve(ok(request, 'nothing')))).toMatchObject({ result: 'fixed' });
    expect(await retestFinding(pair, () => Promise.resolve({ ok: false, refusal: 'no' }))).toMatchObject({ result: 'inconclusive' });
    expect(await retestFinding(pair, (request) => Promise.resolve(ok(request, 'bwmark')))).toMatchObject({
      result: 'inconclusive',
      detail: { reason: 'the negative control also matched the oracle' },
    });
    const old = job(stored('https://t.example/search?q=bwmark'), stored('https://t.example/other'));
    expect(await retestFinding(old, () => Promise.reject(new Error('must not send')))).toMatchObject({ result: 'inconclusive' });
  });
});

describe('class templates', () => {
  const page = (body: string, status = 200) => (request: HttpRequest): HttpResult => ok(request, body, status);
  const bola: Candidate = {
    ...candidate,
    title: 'BOLA on books',
    vulnClass: 'idor',
    cwe: 'CWE-639',
    owasp: 'A01:2021',
    probe: { method: 'GET', url: 'https://t.example/books/2', as_role: 'reader1' },
    control: { method: 'GET', url: 'https://t.example/books/2' },
    oracle: { type: 'body_contains', value: 'secret' },
  };

  it('refuses a signed-out control for access-control classes before sending anything', async () => {
    const { hooks: h, calls } = hooks(page('secret'));
    const verdict = await validateCandidate(bola, h);
    expect(verdict).toMatchObject({ confirmed: false, delta: null });
    expect(verdict.reason).toMatch(/^access_control_signed_out_control/);
    expect(calls).toEqual([]);
    expect(templateRefusal({ ...bola, control: { ...bola.probe, as_role: 'reader2' } })).toBeNull();
  });

  it('proves data open to everyone without a control, signed out, on the content', async () => {
    const exposure: Candidate = { ...candidate, title: 'Debug endpoint lists users', vulnClass: 'exposure', cwe: 'CWE-200', probe: { method: 'GET', url: 'https://t.example/users/v1/_debug' }, oracle: { type: 'body_contains', value: '"username"' } };
    delete (exposure as { control?: unknown }).control;
    const verdict = await validateCandidate(exposure, hooks(page('{"username":"a"}')).hooks);
    expect(verdict).toMatchObject({ confirmed: true, delta: 'none', control: null });
    expect(buildFindingRow({ run: { id: 'r', assetId: 'a' }, candidate: exposure, verdict, agent: 'a', testCaseId: null, credentialHeader: undefined }).row.evidence.proof).toMatchObject({ kind: 'exposure_replay', delta: 'none' });
    expect(templateRefusal({ ...exposure, probe: { ...exposure.probe, as_role: 'r' } })).toMatch(/^no_control_signed_in/);
    expect(templateRefusal({ ...exposure, oracle: { type: 'status_equals', value: '200' } })).toMatch(/^no_control_status_only/);
    expect(templateRefusal({ ...exposure, cwe: 'CWE-89', vulnClass: 'sqli', title: 'SQLi' })).toMatch(/^no_control:/);
  });

  it('never accepts a missing page as the control of a path-segment delta', async () => {
    const phpinfo: Candidate = { ...candidate, probe: { method: 'GET', url: 'https://t.example/phpinfo.php' }, control: { method: 'GET', url: 'https://t.example/phpinfo-nonexistent.php' }, oracle: { type: 'body_contains', value: 'PHP Version' } };
    const verdict = await validateCandidate(phpinfo, hooks((request) => (request.url.includes('nonexistent') ? ok(request, 'Not Found', 404) : ok(request, 'PHP Version 8'))).hooks);
    expect(verdict.confirmed).toBe(false);
    expect(verdict.reason).toMatch(/^control_page_missing/);
    // A payload inside the segment keeps the resource: the 404 control of a quote probe still counts.
    const sqli: Candidate = { ...candidate, probe: { method: 'GET', url: "https://t.example/users/v1/test'" }, control: { method: 'GET', url: 'https://t.example/users/v1/test' }, oracle: { type: 'body_contains', value: 'OperationalError' } };
    const quoted = await validateCandidate(sqli, hooks((request) => (request.url.endsWith("'") ? ok(request, 'sqlite3.OperationalError', 500) : ok(request, 'Not Found', 404))).hooks);
    expect(quoted.confirmed).toBe(true);
  });
});
