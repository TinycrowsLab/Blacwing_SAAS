// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readTokenFromHash, VerifyPanel } from './verify-panel';
import { ApiError } from '../../../../lib/api-error';

function fakeApi(post: ReturnType<typeof vi.fn>): { post: typeof post } {
  return { post };
}

function setHash(hash: string): void {
  window.history.replaceState(null, '', `/signup/verify${hash}`);
}

describe('readTokenFromHash', () => {
  it('reads the token from the fragment only', () => {
    expect(readTokenFromHash('#token=abc_-123')).toBe('abc_-123');
    expect(readTokenFromHash('')).toBeUndefined();
    expect(readTokenFromHash('#token=')).toBeUndefined();
    expect(readTokenFromHash('#other=1')).toBeUndefined();
  });
});

describe('verify panel', () => {
  beforeEach(() => {
    setHash('#token=tok-1');
  });
  afterEach(cleanup);

  it('verifies the token once, sends it in the body and clears it from the address bar', async () => {
    const post = vi.fn().mockResolvedValue({
      outcome: 'tenant_created',
      tenantId: '01900000-0000-7000-8000-000000000001',
      slug: 'acme',
    });
    render(<VerifyPanel api={fakeApi(post)} />);
    expect(await screen.findByText('acme')).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/signup/verify', expect.anything(), { token: 'tok-1' });
    expect(window.location.hash).toBe('');
  });

  it('tells an existing account to sign in and creates nothing', async () => {
    const post = vi.fn().mockResolvedValue({ outcome: 'existing_account' });
    render(<VerifyPanel api={fakeApi(post)} />);
    expect(await screen.findByText('Sign in instead')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to sign in' }).getAttribute('href')).toBe('/login');
  });

  it('shows the invalid-link state for SIGNUP_TOKEN_INVALID', async () => {
    const post = vi
      .fn()
      .mockRejectedValue(
        new ApiError({ status: 400, code: 'SIGNUP_TOKEN_INVALID', title: 'invalid' }),
      );
    render(<VerifyPanel api={fakeApi(post)} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /invalid, expired or already used/,
    );
  });

  it('shows the invalid-link state without calling the API when there is no token', async () => {
    setHash('');
    const post = vi.fn();
    render(<VerifyPanel api={fakeApi(post)} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows a retry message for other failures', async () => {
    const post = vi.fn().mockRejectedValue(new TypeError('offline'));
    render(<VerifyPanel api={fakeApi(post)} />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/could not verify/);
    });
  });
});
