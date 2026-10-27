import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../lib/session';

const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('../lib/session', () => ({ getSession: () => getSession() }));

const REDIRECT = 'NEXT_REDIRECT';
const redirect = vi.fn((to: string): never => {
  throw new Error(`${REDIRECT}:${to}`);
});
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  usePathname: () => '/runs',
}));

const { default: ConsoleLayout } = await import('./(console)/layout');
const { AppShell } = await import('../components/shell/app-shell');
const { Providers } = await import('./providers');

const session: Session = {
  user: { id: 'u1', email: 'owner@acme.test', name: 'Owner' },
  tenant: { id: 't1', slug: 'acme' },
  roles: ['owner', 'analyst'],
};

beforeEach(() => {
  getSession.mockReset();
  redirect.mockClear();
});

describe('(console) layout', () => {
  it('redirects to /login without a session, before rendering children', async () => {
    getSession.mockResolvedValue(null);
    await expect(ConsoleLayout({ children: 'protected' })).rejects.toThrow(`${REDIRECT}:/login`);
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/login');
  });

  it('lets a session outage propagate to the error boundary instead of redirecting', async () => {
    getSession.mockRejectedValue(new Error('down'));
    await expect(ConsoleLayout({ children: 'x' })).rejects.toThrow('down');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('renders the shell with user and roles and mounts children', async () => {
    getSession.mockResolvedValue(session);
    const html = renderToString(await ConsoleLayout({ children: <p>page body</p> }));
    expect(html).toContain('data-testid="app-shell"');
    expect(html).toContain('>O<');
    expect(html).toContain('page body');
  });

  it('passes only user and roles to the client shell (no tenant, no tokens)', async () => {
    getSession.mockResolvedValue({ ...session });
    const element = (await ConsoleLayout({ children: null })) as {
      props: Record<string, unknown>;
    };
    expect(Object.keys(element.props).sort()).toEqual(['children', 'roles', 'user']);
  });
});

describe('AppShell', () => {
  it('falls back to the email initial when the name is empty', () => {
    const html = renderToString(
      <AppShell user={{ ...session.user, name: '' }} roles={[]}>
        c
      </AppShell>,
    );
    expect(html).toContain('>O<');
    expect(html).toContain('id="main-content"');
  });
});

describe('providers', () => {
  it('wraps children in the root providers', () => {
    expect(renderToString(<Providers>inside</Providers>)).toContain('inside');
  });
});
