import { describe, expect, it } from 'vitest';

import {
  bearerize,
  headerNameError,
  normalizePath,
  normalizePaths,
  normalizeTarget,
  noteText,
  parseCost,
  parseMinutes,
  parseRequests,
  reasonChars,
  reasonEnough,
  slugifyRole,
  splitHeaderPaste,
} from './normalize';

const target = (raw: string) => {
  const r = normalizeTarget(raw);
  return r.ok ? { origin: r.origin, display: r.display, notes: r.notes.map((n) => noteText(n)) } : { error: r.message };
};

describe('normalizeTarget (§10.1 table)', () => {
  it.each([
    ['example.com', 'https://example.com', ['Added https://']],
    ['  EXAMPLE.com/ ', 'https://example.com', ['Added https://', 'Lower-cased the address']],
    [
      'Staging.Tinycrows.com/login',
      'https://staging.tinycrows.com',
      ['Added https://', 'Lower-cased the address', 'Set aside /login'],
    ],
    ['127.0.0.1:3001/#/search', 'http://127.0.0.1:3001', ['Added http:// (local address)', 'Set aside /#/search']],
    ['localhost:3000', 'http://localhost:3000', ['Added http:// (local address)']],
    ['http://Shop.Example.com:80/a?b=1', 'http://shop.example.com', ['Lower-cased the address', 'Set aside /a?b=1']],
    [
      'https://u:p@example.com',
      'https://example.com',
      ['Removed a username and password. Add test accounts on the plan instead.'],
    ],
    ['<https://example.com>.', 'https://example.com', []],
    ['[::1]:8080', 'http://[::1]:8080', ['Added http:// (local address)']],
    ['192.168.1.20', 'http://192.168.1.20', ['Added http:// (local address)']],
    ['jatin@tinycrows.com', 'https://tinycrows.com', ['Added https://', 'Used the domain of the e-mail address']],
  ])('%s gives %s', (raw, origin, notes) => {
    expect(target(raw)).toMatchObject({ origin, notes });
  });

  it('punycodes an IDN for the API and shows it in Unicode', () => {
    expect(target('münchen.de')).toEqual({
      origin: 'https://xn--mnchen-3ya.de',
      display: 'https://münchen.de',
      notes: ['Added https://'],
    });
  });

  it.each([
    ['ftp://x.com', 'Blackwing audits web apps over http or https.'],
    ['example', "That doesn't look like a web address yet. Try something like app.example.com"],
    ['http://exa mple.com', "That doesn't look like a web address yet. Try something like app.example.com"],
    ['example.123', "That doesn't look like a web address yet. Try something like app.example.com"],
  ])('%s is refused with a friendly message', (raw, error) => {
    expect(target(raw)).toEqual({ error });
  });

  it('says nothing for an empty field (Continue stays disabled)', () => {
    expect(normalizeTarget('   ')).toEqual({ ok: false, message: '', empty: true });
  });
});

describe('excluded paths (§10.2)', () => {
  const origin = 'https://app.example.com';
  it.each([
    ['admin', '/admin'],
    ['/admin/', '/admin'],
    ['/admin/**', '/admin'],
    ['/admin/*', '/admin'],
    ['https://app.example.com/internal/x', '/internal/x'],
    ['/', '/'],
  ])('%s becomes the prefix %s', (token, path) => {
    expect(normalizePath(token, origin)).toEqual({ ok: true, path });
  });

  it('refuses another origin and odd characters', () => {
    expect(normalizePath('https://other.example.com/a', origin)).toEqual({
      ok: false,
      message: "That's on another site, so it's already out of scope.",
    });
    expect(normalizePath('/a<b>', origin).ok).toBe(false);
  });

  it('splits a pasted list, drops duplicates silently and stops at 50', () => {
    expect(normalizePaths('/admin, /internal\n/admin admin/', origin)).toEqual({
      paths: ['/admin', '/internal'],
      error: null,
    });
    const many = Array.from({ length: 51 }, (_, i) => `/p${i}`).join(' ');
    const r = normalizePaths(many, origin);
    expect(r.paths).toHaveLength(50);
    expect(r.error).toBe('Up to 50 paths.');
  });
});

describe('limits (§10.3)', () => {
  const minutes = { min: 1, max: 120 };
  it.each([
    ['20', 20],
    ['20m', 20],
    ['1h', 60],
    ['1h30', 90],
    ['1:30', 90],
    ['90 minutes', 90],
    ['1.5h', 90],
  ])('minutes %s = %d', (text, value) => {
    expect(parseMinutes(text, minutes)).toEqual({ ok: true, value, note: null });
  });

  it('clamps instead of blocking', () => {
    expect(parseMinutes('3h', minutes)).toEqual({
      ok: true,
      value: 120,
      note: 'Set to 120 minutes, the most this workspace allows.',
    });
    expect(parseRequests('2', { min: 10, max: 5000 })).toMatchObject({ value: 10 });
    expect(parseCost('$0.10', { min: 0.5, max: 100 })).toEqual({
      ok: true,
      value: 0.5,
      note: 'Set to $0.50, the least this workspace allows.',
    });
    expect(parseRequests('9k', { min: 10, max: 5000 })).toMatchObject({
      note: 'Set to 5,000 requests, the most this workspace allows.',
    });
  });

  it.each([
    ['1000', 1000],
    ['1,000', 1000],
    ['1k', 1000],
    ['1.5k', 1500],
  ])('requests %s = %d', (text, value) => {
    expect(parseRequests(text, { min: 10, max: 5000 })).toMatchObject({ ok: true, value });
  });

  it.each([
    ['8', 8],
    ['$8', 8],
    ['12.50', 12.5],
    ['8 usd', 8],
  ])('cost %s = %d', (text, value) => {
    expect(parseCost(text, { min: 0.5, max: 100 })).toMatchObject({ ok: true, value });
  });

  it('refuses what it cannot read', () => {
    expect(parseMinutes('soon', minutes).ok).toBe(false);
    expect(parseMinutes('', minutes).ok).toBe(false);
    expect(parseRequests('lots', { min: 10, max: 5000 }).ok).toBe(false);
    expect(parseCost('8 euros', { min: 0.5, max: 100 }).ok).toBe(false);
  });
});

describe('test accounts and reasons (§10.3)', () => {
  it('slugifies roles', () => {
    expect(slugifyRole('Customer A')).toBe('customer_a');
    expect(slugifyRole('  admin-2 ')).toBe('admin-2');
    expect(slugifyRole('42')).toBeNull();
  });

  it('splits a pasted header line and adds Bearer to a bare JWT', () => {
    expect(splitHeaderPaste('Authorization: Bearer abc')).toEqual({ header: 'Authorization', value: 'Bearer abc' });
    expect(splitHeaderPaste('Cookie: a=b; c=d')).toEqual({ header: 'Cookie', value: 'a=b; c=d' });
    expect(splitHeaderPaste('just-a-token')).toBeNull();
    expect(bearerize('authorization', 'eyJhbGc.eyJzdWI.sig')).toEqual({
      value: 'Bearer eyJhbGc.eyJzdWI.sig',
      note: 'Added "Bearer " in front of the token.',
    });
    expect(bearerize('Cookie', 'eyJhbGc.eyJzdWI.sig').note).toBeNull();
  });

  it('refuses reserved and malformed header names', () => {
    expect(headerNameError('Authorization')).toBeNull();
    expect(headerNameError('Host')).toBe('Blackwing sets host itself.');
    expect(headerNameError('X Token')).not.toBeNull();
  });

  it('counts non-space characters for reasons', () => {
    expect(reasonChars('  a b  c ')).toBe(3);
    expect(reasonEnough('Our test lab')).toBe(true);
    expect(reasonEnough('lab     ')).toBe(false);
  });
});

describe('normalizeTarget never reads a short or hex IP as another address', () => {
  it.each(['127.1', '0x7f.0.0.1:3001', '1.2.3', '010.0.0.1'])('%s is refused', (raw) => {
    expect(target(raw)).toEqual({
      error: 'That looks like an IP address, but not all four numbers are there. Write it in full, like 192.168.1.20',
    });
  });
});
