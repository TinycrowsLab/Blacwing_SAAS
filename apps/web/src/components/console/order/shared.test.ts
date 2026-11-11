import { describe, expect, it } from 'vitest';

import { checkAccounts } from './plan-editors';
import { approvalEnded, composeObjective, readObjective, recommendedCare, recommendedProof, toggleFocus, wasApproved } from './shared';

describe('objective chips', () => {
  it('composes the objective from the template and reads it back', () => {
    const o = composeObjective(['access', 'login'], 'Checkout matters most.');
    expect(o).toBe('Look for broken access control, and weak login and session handling. Checkout matters most.');
    expect(readObjective(o)).toEqual({ keys: ['access', 'login'], text: 'Checkout matters most.' });
  });

  it('falls back to the broad sweep and keeps foreign objectives as free text', () => {
    expect(composeObjective([], '')).toBe('Look for the OWASP Top 10.');
    expect(readObjective('Map the API first.')).toEqual({ keys: [], text: 'Map the API first.' });
  });

  it('a specific chip drops the broad sweep, and clearing them brings it back', () => {
    expect(toggleFocus(['broad'], 'apis', true)).toEqual(['apis']);
    expect(toggleFocus(['apis'], 'apis', false)).toEqual(['broad']);
    expect(toggleFocus(['apis'], 'broad', true)).toEqual(['broad']);
  });
});

describe('recommendedCare', () => {
  it('suggests probing gently for local, private and staging hosts, and look-only otherwise', () => {
    expect(recommendedCare('127.0.0.1:3001')).toBe('active_safe');
    expect(recommendedCare('staging.example.com')).toBe('active_safe');
    expect(recommendedCare('app-dev.example.com')).toBe('active_safe');
    expect(recommendedCare('shop.example.com')).toBe('passive');
    expect(recommendedCare('testimonials.example.com')).toBe('passive');
  });
});

describe('checkAccounts', () => {
  it('slugifies roles and needs unique roles, a usable header and a value', () => {
    expect(checkAccounts([{ role: 'Customer A', headerName: 'Authorization', headerValue: 'Bearer x' }])).toEqual({
      accounts: [{ role: 'customer_a', headerName: 'Authorization', headerValue: 'Bearer x' }],
    });
    expect(
      checkAccounts([
        { role: 'admin', headerName: 'Cookie', headerValue: 'a=b' },
        { role: 'Admin', headerName: 'Cookie', headerValue: 'c=d' },
      ]),
    ).toEqual({ error: 'Each role needs its own name.' });
    expect(checkAccounts([{ role: 'x', headerName: 'Host', headerValue: 'y' }])).toEqual({ error: 'Blackwing sets host itself.' });
    expect(checkAccounts([{ role: 'x', headerName: 'Cookie', headerValue: ' ' }])).toEqual({ error: 'Paste the header value.' });
  });
  it('keeps a saved account without its value (Blackwing holds it), and asks for a new one', () => {
    expect(checkAccounts([{ role: 'alice', headerName: 'Authorization', headerValue: '', saved: true }])).toEqual({
      accounts: [{ role: 'alice', headerName: 'Authorization' }],
    });
    expect(checkAccounts([{ role: 'bob', headerName: 'Authorization', headerValue: '' }])).toEqual({
      error: 'Paste the header value.',
    });
  });
});

describe('ownership and approvals', () => {
  const asset = (methods: ('http_token' | 'owner_attestation')[]) => ({ verification: { token: 't', wellKnownUrl: 'u', methods } });
  it("recommends the owner's word only where the API accepts it", () => {
    expect(recommendedProof('127.0.0.1:3082', asset(['http_token', 'owner_attestation']))).toBe('attest');
    expect(recommendedProof('127.0.0.1:13400', asset(['http_token']))).toBe('file');
    expect(recommendedProof('shop.example.com', asset(['http_token', 'owner_attestation']))).toBe('file');
  });
  it('an approval whose run was stopped or failed is used up', () => {
    expect(wasApproved('killed')).toBe(true);
    expect(approvalEnded('killed')).toBe(true);
    expect(approvalEnded('failed')).toBe(true);
    expect(approvalEnded('approved')).toBe(false);
  });
});

describe('checkAccounts, login-form accounts', () => {
  it('takes a username and password (and an optional login page), and asks for what is missing', () => {
    const row = { role: 'admin', headerName: 'Authorization', headerValue: '', login: true };
    expect(checkAccounts([{ ...row, username: ' admin ', password: 'pw', loginUrl: '' }])).toEqual({ accounts: [{ role: 'admin', username: 'admin', password: 'pw' }] });
    expect(checkAccounts([{ ...row, username: 'a', password: 'pw', loginUrl: 'http://x.test/login' }])).toEqual({ accounts: [{ role: 'admin', username: 'a', password: 'pw', loginUrl: 'http://x.test/login' }] });
    expect(checkAccounts([{ ...row, username: '', password: 'pw' }])).toEqual({ error: 'Type the username.' });
    expect(checkAccounts([{ ...row, username: 'a', password: '' }])).toEqual({ error: 'Type the password.' });
    expect(checkAccounts([{ ...row, username: 'a', password: '', saved: true }])).toEqual({ accounts: [{ role: 'admin', username: 'a' }] });
  });
});
