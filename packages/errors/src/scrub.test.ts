import { describe, expect, it } from 'vitest';

import { scrub, scrubbed, scrubDeep, scrubHeaders } from './scrub.js';

// Benign, made-up lab values. The JWT is a structurally valid but unsigned sample.
const JWT =
  'eyJhbGciOiJSUzI1NiJ9.eyJzdGF0dXMiOiJzdWNjZXNzIiwiZGF0YSI6eyJpZCI6MX19.c2lnbmF0dXJlLXNhbXBsZQ';
const BCRYPT = `$2b$10$${'a'.repeat(53)}`;

describe('scrub', () => {
  it('1. applies the built-in credential patterns', () => {
    expect(scrub('see http://user:pw@lab.local/x')).toBe('see http://[REDACTED]@lab.local/x');
  });

  it('2. replaces JWT-shaped strings', () => {
    expect(scrub(`token is ${JWT} here`)).toBe(`token is ${scrubbed('token')} here`);
  });

  it('3. replaces credential header lines in raw HTTP and curl', () => {
    expect(scrub('GET / HTTP/1.1\r\nCookie: PHPSESSID=abc123; security=low\r\nHost: x')).toBe(
      'GET / HTTP/1.1\r\nCookie: [redacted: cookie]\r\nHost: x',
    );
    const curl = `curl -H 'Authorization: Bearer ${JWT}' http://127.0.0.1:3001/rest/basket/1`;
    expect(scrub(curl)).toBe(
      "curl -H 'Authorization: [redacted: credential]' http://127.0.0.1:3001/rest/basket/1",
    );
    expect(scrub(`Set-Cookie: token=${JWT}; Path=/`)).toBe('Set-Cookie: [redacted: cookie]');
    expect(scrub('X-Api-Key: k-123456')).toBe('X-Api-Key: [redacted: credential]');
  });

  it('3. leaves prose that only mentions a header alone', () => {
    expect(scrub('The session cookie: it is not HttpOnly.')).toBe(
      'The session cookie: it is not HttpOnly.',
    );
  });

  it('4. replaces JSON fields whose key names a secret (Juice Shop login answer)', () => {
    const body = `{"authentication":{"token":"${JWT}","bid":1,"umail":"admin@juice-sh.op"}}`;
    const out = scrub(body);
    expect(out).toBe(
      '{"authentication":{"token":"[redacted: token]","bid":1,"umail":"admin@juice-sh.op"}}',
    );
    expect(scrub('{"access_token": "abc", "seedPhrase":"one two three"}')).toBe(
      '{"access_token": "[redacted: secret]", "seedPhrase":"[redacted: secret]"}',
    );
  });

  it('4. replaces plaintext passwords (VAmPI /users/v1/_debug)', () => {
    const body =
      '{"users":[{"admin":false,"email":"mail1@mail.com","password":"pass1","username":"name1"}]}';
    expect(scrub(body)).toBe(
      '{"users":[{"admin":false,"email":"mail1@mail.com","password":"[redacted: password]","username":"name1"}]}',
    );
  });

  it('4. handles escaped JSON inside a string', () => {
    expect(scrub('{\\"password\\":\\"pw1\\"}')).toBe('{\\"password\\":\\"[redacted: password]\\"}');
  });

  it('5. replaces form and query secrets', () => {
    expect(scrub('username=admin&password=letmein&Login=Login')).toBe(
      'username=admin&password=[redacted: secret]&Login=Login',
    );
    expect(scrub('GET /api?token=abc&page=2')).toBe('GET /api?token=[redacted: secret]&page=2');
    expect(scrub('-b PHPSESSID=abc123')).toBe('-b PHPSESSID=[redacted: secret]');
    expect(scrub('bypass=1&inside=2')).toBe('bypass=1&inside=2');
  });

  it("6. replaces config assignments (DVWA's config.inc.php)", () => {
    expect(scrub("$_DVWA[ 'db_password' ] = 'vulnerables';")).toBe(
      "$_DVWA[ 'db_password' ] = '[redacted: password]';",
    );
    expect(scrub("$_DVWA[ 'db_user' ] = 'app';")).toBe("$_DVWA[ 'db_user' ] = 'app';");
    expect(scrub("define('API_SECRET', 'abc');")).toBe("define('API_SECRET', '[redacted: secret]');");
  });

  it('7. replaces password hashes but keeps bare hex (body hashes are proof values)', () => {
    expect(scrub(`hash ${BCRYPT} end`)).toBe('hash [redacted: hash] end');
    expect(scrub('$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA end')).toBe('[redacted: hash] end');
    const hex = 'a'.repeat(64);
    expect(scrub(`bodySha256 ${hex}`)).toBe(`bodySha256 ${hex}`);
    expect(scrub(`{"password":"0192023a7bbd73250516f069df18b500"}`)).toBe(
      '{"password":"[redacted: password]"}',
    );
  });

  it('8. replaces prose, config and XML forms an agent writes (DVWA db password, api keys)', () => {
    const cases: [string, string][] = [
      ['`db_password` `vulnerables`', '`db_password` `[redacted: password]`'],
      ['db_user `app` and db_password `vulnerables`', 'db_user `app` and db_password `[redacted: password]`'],
      ['db_password = vulnerables', 'db_password = [redacted: password]'],
      ['password: hunter2xyz', 'password: [redacted: password]'],
      ['the admin password is admin123', 'the admin password is [redacted: password]'],
      ['{"pwd":"pass1","pass":"pass2"}', '{"pwd":"[redacted: secret]","pass":"[redacted: secret]"}'],
      ['<password>pass1</password>', '<password>[redacted: password]</password>'],
      ['api_key: sk-live-abc123', 'api_key: [redacted: secret]'],
      ['?password_new=bwtestA1&password_conf=bwtestB2&Change=Change', '?password_new=[redacted: secret]&password_conf=[redacted: secret]&Change=Change'],
    ];
    for (const [input, output] of cases) expect(scrub(input), input).toBe(output);
  });

  it('8. leaves prose and evidence that only mention a secret alone', () => {
    for (const text of [
      'unrecognized token: "\'1"',
      'the password is wrong',
      'Plaintext password: exposed at /users/v1/_debug',
      'db_user `app`',
    ]) expect(scrub(text), text).toBe(text);
  });

  it('leaves role placeholders unchanged', () => {
    const text = "curl -H 'Authorization: [redacted: role alice]' http://127.0.0.1:5077/users/v1";
    expect(scrub(text)).toBe(text);
    expect(scrub('{"token":"[redacted: role bob]"}')).toBe('{"token":"[redacted: role bob]"}');
    const curl = "curl -H 'authorization: <alice credential>' http://127.0.0.1:5077/me";
    expect(scrub(curl)).toBe(curl);
  });

  it('is idempotent', () => {
    const samples = [
      `curl -H 'Authorization: Bearer ${JWT}' -d '{"password":"x","email":"a@b"}' http://h/?token=1`,
      `Set-Cookie: token=${JWT}; Path=/\nCookie: a=b`,
      "$_DVWA[ 'db_password' ] = 'vulnerables';",
      `{"authentication":{"token":"${JWT}"}} ${BCRYPT}`,
    ];
    for (const s of samples) expect(scrub(scrub(s))).toBe(scrub(s));
  });

  it('is linear on hostile input', () => {
    const hostile = `${'a'.repeat(50_000)}=${'"'.repeat(10_000)}eyJ${'x'.repeat(50_000)}`;
    const started = Date.now();
    scrub(hostile);
    scrub('Cookie:'.repeat(20_000));
    scrub(`"${'k'.repeat(30_000)}":"${'v'.repeat(30_000)}`);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('scrubHeaders', () => {
  it('replaces credential headers whole and scrubs the rest', () => {
    expect(
      scrubHeaders({
        Authorization: 'Bearer abcdefghijk',
        'set-cookie': `token=${JWT}; Path=/`,
        'x-api-key': '[redacted: role alice]',
        'content-type': 'application/json',
        location: `/cb?token=${JWT}`,
      }),
    ).toEqual({
      Authorization: '[redacted: credential]',
      'set-cookie': '[redacted: cookie]',
      'x-api-key': '[redacted: role alice]',
      'content-type': 'application/json',
      location: '/cb?token=[redacted: token]',
    });
  });
});

describe('scrubDeep', () => {
  it('walks objects and arrays, replaces secret keys, scrubs headers and keeps proof keys', () => {
    const input = {
      bodySha256: 'f'.repeat(64),
      exchangeId: 'x-1',
      fingerprint: 'abc',
      identityKey: 'def',
      password: 'pw',
      hash: 'b'.repeat(40),
      totpSecret: 'IFRXG',
      pin: 1234,
      list: [{ apiKey: 'k1' }, `Bearer ${JWT}`],
      request: { headers: { cookie: 'a=b', accept: '*/*' }, body: '{"password":"x"}' },
      nested: { token: '[redacted: role alice]' },
    };
    const out = scrubDeep(input);
    expect(out).toEqual({
      bodySha256: 'f'.repeat(64),
      exchangeId: 'x-1',
      fingerprint: 'abc',
      identityKey: 'def',
      password: '[redacted: password]',
      hash: '[redacted: secret]',
      totpSecret: '[redacted: secret]',
      pin: 1234,
      list: [{ apiKey: '[redacted: secret]' }, 'Bearer [REDACTED]'],
      request: {
        headers: { cookie: '[redacted: cookie]', accept: '*/*' },
        body: '{"password":"[redacted: password]"}',
      },
      nested: { token: '[redacted: role alice]' },
    });
    expect(input.password).toBe('pw');
  });

  it('caps depth', () => {
    let v: unknown = 'leaf';
    for (let i = 0; i < 40; i += 1) v = { v };
    expect(JSON.stringify(scrubDeep(v))).toContain('[redacted: secret]');
  });
});
