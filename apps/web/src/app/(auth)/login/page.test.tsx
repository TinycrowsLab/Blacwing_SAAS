// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import LoginPage from './page';

async function renderPage(params: Record<string, string | string[] | undefined>): Promise<void> {
  render(await LoginPage({ searchParams: Promise.resolve(params) }));
}

describe('login page', () => {
  afterEach(cleanup);

  it('links to the BFF login route', async () => {
    await renderPage({});
    expect(screen.getByRole('heading', { name: 'Sign in to Blackwing' })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Continue with single sign-on' }).getAttribute('href'),
    ).toBe('/api/auth/login');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the failure reason and offers a retry that carries returnTo along', async () => {
    await renderPage({ error: 'idp_unavailable', returnTo: '/runs/1?a=b' });
    expect(screen.getByRole('alert').textContent).toMatch(/unavailable/);
    expect(screen.getByRole('link', { name: 'Try again' }).getAttribute('href')).toBe(
      '/api/auth/login?returnTo=%2Fruns%2F1%3Fa%3Db',
    );
  });

  it('never reflects an unknown error value', async () => {
    await renderPage({ error: '<img src=x onerror=alert(1)>' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.innerHTML).not.toContain('onerror');
  });
});

describe('login page Google option', () => {
  afterEach(cleanup);

  it('offers Continue with Google that starts the Google broker, next to the normal sign-in', async () => {
    await renderPage({});
    expect(screen.getByRole('link', { name: 'Continue with Google' }).getAttribute('href')).toBe(
      '/api/auth/login?idp=google',
    );
    expect(
      screen.getByRole('link', { name: 'Continue with single sign-on' }).getAttribute('href'),
    ).toBe('/api/auth/login');
  });

  it('carries returnTo into the Google start link', async () => {
    await renderPage({ returnTo: '/demo' });
    expect(screen.getByRole('link', { name: 'Continue with Google' }).getAttribute('href')).toBe(
      '/api/auth/login?idp=google&returnTo=%2Fdemo',
    );
  });
});
