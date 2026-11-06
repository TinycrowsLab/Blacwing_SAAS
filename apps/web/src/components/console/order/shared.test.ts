import { describe, expect, it } from 'vitest';

import { checkAccounts } from './plan-editors';
import { composeObjective, readObjective, recommendedCare, toggleFocus } from './shared';

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
});
