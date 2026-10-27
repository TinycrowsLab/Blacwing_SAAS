// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let pathname = '/runs/run_01HZXABCDEF';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }) }));

const { AppShell, NAV_COLLAPSED_KEY } = await import('./app-shell');

const user = { id: 'u1', email: 'dev@acme.test', name: 'Dev' };

beforeEach(() => {
  pathname = '/runs/run_01HZXABCDEF';
  window.localStorage.clear();
});
afterEach(cleanup);

describe('AppShell', () => {
  it('shows a developer only permitted items, marks the active one and ends breadcrumbs on the current page', () => {
    render(
      <AppShell user={user} roles={['developer']}>
        body
      </AppShell>,
    );
    const nav = screen.getAllByRole('navigation', { name: 'Primary' })[0];
    expect(nav?.textContent).toContain('Runs');
    expect(nav?.textContent).not.toContain('Members');
    expect(nav?.textContent).not.toContain('Audit log');
    expect(screen.getAllByRole('link', { name: 'Runs' })[0]?.getAttribute('aria-current')).toBe(
      'page',
    );
    const current = document.querySelector('[aria-current="page"]:not(a)');
    expect(current?.textContent).toBe('Run');
    expect(document.querySelector('main#main-content')?.textContent).toBe('body');
  });

  it('does not crash with empty roles', () => {
    render(
      <AppShell user={user} roles={[]}>
        x
      </AppShell>,
    );
    expect(screen.getAllByRole('link', { name: 'Overview' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('navigation', { name: 'Primary' })?.textContent).not.toContain(
      'Runs',
    );
  });

  it('persists the collapsed state and restores it on remount', async () => {
    const { unmount } = render(
      <AppShell user={user} roles={['developer']}>
        x
      </AppShell>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(window.localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('1');
    expect(screen.getByTestId('app-shell-sidebar').dataset.collapsed).toBe('true');
    unmount();
    render(
      <AppShell user={user} roles={['developer']}>
        x
      </AppShell>,
    );
    expect(await screen.findByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
  });

  it('still works when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(
      <AppShell user={user} roles={['developer']}>
        x
      </AppShell>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    vi.restoreAllMocks();
  });

  it('opens the navigation drawer from the keyboard-reachable trigger', async () => {
    render(
      <AppShell user={user} roles={['org_admin']}>
        x
      </AppShell>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Members' })).toBeTruthy();
  });
});
