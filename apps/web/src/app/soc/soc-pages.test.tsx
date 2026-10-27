// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KillLinkPreview } from '../../lib/soc-kill';

const preview = vi.fn<() => Promise<KillLinkPreview>>();
vi.mock('../../lib/soc-kill', () => ({ previewKillLink: () => preview() }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('./kill/[token]/actions', () => ({ confirmKill: () => Promise.resolve() }));

const { default: SocKillPage } = await import('./kill/[token]/page');
const { default: SocKillResultPage } = await import('./kill/result/page');

afterEach(cleanup);
beforeEach(() => {
  preview.mockReset();
});

const page = async () => SocKillPage({ params: Promise.resolve({ token: 'a.b.c' }) });

describe('SOC kill confirmation page', () => {
  it('shows the asset label and a confirm button for a live link', async () => {
    preview.mockResolvedValue({ kind: 'valid', scope: 'asset', label: 'Payments API' });
    render(await page());
    expect(screen.getByRole('heading').textContent).toBe('Stop testing of Payments API');
    expect(screen.getByRole('button', { name: 'Stop testing now' })).toBeTruthy();
  });

  it('shows the generic invalid page, with no button, for any refusal', async () => {
    preview.mockResolvedValue({ kind: 'invalid' });
    render(await page());
    expect(screen.getByRole('heading').textContent).toBe('This link is no longer valid');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('tells a rate-limited visitor to wait', async () => {
    preview.mockResolvedValue({ kind: 'limited' });
    render(await page());
    expect(screen.getByRole('alert').textContent).toContain('Too many attempts');
  });
});

describe('SOC kill result page', () => {
  it.each([
    ['done', 'Testing is being stopped'],
    ['limited', 'Too many attempts'],
    ['invalid', 'This link is no longer valid'],
    ['anything-else', 'This link is no longer valid'],
  ])('renders %s', async (r, title) => {
    render(await SocKillResultPage({ searchParams: Promise.resolve({ r }) }));
    expect(screen.getByRole('heading').textContent).toBe(title);
  });
});
