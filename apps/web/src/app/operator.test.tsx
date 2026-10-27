import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../lib/session';

const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('../lib/session', () => ({ getSession: () => getSession() }));

const REDIRECT = 'NEXT_REDIRECT';
const redirect = vi.fn((to: string): never => {
  throw new Error(`${REDIRECT}:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

const { default: OperatorLayout } = await import('./(operator)/layout');

const session: Session = {
  user: { id: 'u1', email: 'op@tinycrows.test', name: 'Operator' },
  tenant: { id: 't1', slug: 'acme' },
  roles: ['org_admin'],
};

beforeEach(() => {
  getSession.mockReset();
  redirect.mockClear();
});

describe('(operator) layout', () => {
  it('redirects to /login without a session, before rendering children', async () => {
    getSession.mockResolvedValue(null);
    await expect(OperatorLayout({ children: 'protected' })).rejects.toThrow(`${REDIRECT}:/login`);
    expect(redirect).toHaveBeenCalledExactlyOnceWith('/login');
  });

  it('lets a session outage propagate to the error boundary instead of redirecting', async () => {
    getSession.mockRejectedValue(new Error('down'));
    await expect(OperatorLayout({ children: 'x' })).rejects.toThrow('down');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('renders the operator frame around the page, and puts no session data in it', async () => {
    getSession.mockResolvedValue(session);
    const html = renderToString(await OperatorLayout({ children: <p>page body</p> }));
    expect(html).toContain('data-testid="operator-shell"');
    expect(html).toContain('page body');
    expect(html).not.toContain('op@tinycrows.test');
  });
});
