// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignupForm } from './signup-form';
import { ApiError } from '../../../../lib/api-error';

function fakeApi(post: ReturnType<typeof vi.fn>): { post: typeof post } {
  return { post };
}

async function fill(email: string, orgName: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Work email'), email);
  await user.type(screen.getByLabelText('Organisation name'), orgName);
  await user.click(screen.getByRole('button', { name: 'Send verification link' }));
}

describe('signup form', () => {
  afterEach(cleanup);

  it('posts the address and name to /v1/signup and shows the same message whatever the address', async () => {
    const post = vi.fn().mockResolvedValue({ status: 'verification_requested' });
    render(<SignupForm api={fakeApi(post)} />);
    await fill('  owner@example.com ', 'Acme Ltd');
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeTruthy();
    });
    expect(post).toHaveBeenCalledWith('/signup', expect.anything(), {
      email: 'owner@example.com',
      orgName: 'Acme Ltd',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the server detail when the request is refused', async () => {
    const post = vi.fn().mockRejectedValue(
      new ApiError({
        status: 422,
        code: 'VALIDATION',
        title: 'Validation failed',
        detail: 'organisation name yields no usable slug',
      }),
    );
    render(<SignupForm api={fakeApi(post)} />);
    await fill('owner@example.com', '!!!');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'organisation name yields no usable slug',
    );
  });

  it('falls back to a generic message for a network failure', async () => {
    const post = vi.fn().mockRejectedValue(new TypeError('offline'));
    render(<SignupForm api={fakeApi(post)} />);
    await fill('owner@example.com', 'Acme');
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not send/);
    expect(screen.queryByText(/offline/)).toBeNull();
  });
});
