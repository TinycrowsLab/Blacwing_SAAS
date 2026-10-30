// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { PermissionDenied } from '@blackwing/ui';

import SettingsLayout from './layout';
import OrgSettingsPage from './org/page';
import { OrgSettingsForm } from '../../../components/settings/org-settings-form';
import { getSession, type Session } from '../../../lib/session';

import type { ReactElement, ReactNode } from 'react';

vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('../../../lib/session', () => ({ getSession: vi.fn() }));

const session = (roles: readonly string[]): Session => ({
  user: { id: 'usr_1', email: 'someone@acme.test', name: 'Someone' },
  tenant: { id: '0198f0a0-0000-7000-8000-00000000000a', slug: 'acme' },
  roles: [...roles],
});

/** The elements a server component returns, as a list of their component types (top level only). */
function childTypes(element: ReactNode): unknown[] {
  const el = element as ReactElement<{ children?: ReactNode }>;
  const children = Array.isArray(el.props.children) ? el.props.children : [el.props.children];
  return children.map((child) => (child as ReactElement | null)?.type);
}

describe('settings layout', () => {
  it('shows the permission-denied state to a member with no settings permission', async () => {
    vi.mocked(getSession).mockResolvedValue(session(['developer']));
    const element = (await SettingsLayout({ children: null })) as ReactElement;
    expect(element.type).toBe(PermissionDenied);
  });

  it('renders the sub-navigation and the page to a tenant administrator', async () => {
    vi.mocked(getSession).mockResolvedValue(session(['org_admin']));
    const element = (await SettingsLayout({ children: null })) as ReactElement;
    expect(element.type).toBe('div');
    expect(JSON.stringify(element)).toContain('/settings/org');
  });
});

describe('organisation settings page', () => {
  it('never shows the form to a caller without settings:read; shows the permission-denied state', async () => {
    vi.mocked(getSession).mockResolvedValue(session(['auditor']));
    const element = (await OrgSettingsPage()) as ReactElement;
    expect(element.type).toBe(PermissionDenied);
    expect(childTypes(element)).not.toContain(OrgSettingsForm);
  });

  it('shows the form to a tenant administrator, and makes it editable only with settings:write', async () => {
    vi.mocked(getSession).mockResolvedValue(session(['org_admin']));
    const element = (await OrgSettingsPage()) as ReactElement;
    const form = (element.props as { children: ReactElement[] }).children.find(
      (child) => child.type === OrgSettingsForm,
    );
    expect(form?.props).toEqual({ canEdit: true });
  });
});
