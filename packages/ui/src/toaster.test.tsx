// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetToasts } from './components/toaster';
import { DEFAULT_TOASTER_CONFIG, Toaster, toast } from './index';

afterEach(() => {
  cleanup();
  resetToasts();
  vi.useRealTimers();
});

describe('toast helper', () => {
  it('shows a success toast in the polite live region', () => {
    render(<Toaster />);
    act(() => {
      toast.success({ title: 'Saved' });
    });
    expect(document.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });

  it('shows an error toast with its copyable trace id', () => {
    render(<Toaster />);
    act(() => {
      toast.error({ title: 'Something failed', traceId: 'trc_abc123' });
    });
    expect(document.querySelector('[role="status"][aria-live="assertive"]')).not.toBeNull();
    expect(screen.getByText('trc_abc123')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy trace ID' })).toBeTruthy();
  });

  it('drops a trace id that is not a short id token', () => {
    render(<Toaster />);
    act(() => {
      toast.error({ title: 'Failed', traceId: 'Bearer abcdefghijklmnop secret value' });
    });
    expect(screen.queryByText(/Bearer/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy trace ID' })).toBeNull();
  });

  it('caps the visible stack and drops the oldest toasts', () => {
    render(<Toaster />);
    for (let i = 1; i <= DEFAULT_TOASTER_CONFIG.maxVisible + 2; i += 1) {
      act(() => {
        toast.info({ title: `Note ${i}` });
      });
    }
    expect(screen.queryByText('Note 1')).toBeNull();
    expect(screen.queryByText('Note 2')).toBeNull();
    expect(screen.getByText('Note 5')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(DEFAULT_TOASTER_CONFIG.maxVisible);
  });

  it('can be dismissed by keyboard from its close button', async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    act(() => {
      toast.info({ title: 'Dismiss me' });
    });
    const toastEl = screen.getByText('Dismiss me').closest('li') as HTMLElement;
    const close = within(toastEl).getByRole('button', { name: 'Close' });
    close.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('Dismiss me')).toBeNull();
  });

  it('dismiss removes a toast by id', () => {
    render(<Toaster />);
    let id = 0;
    act(() => {
      id = toast.info({ title: 'Gone soon' });
    });
    act(() => {
      toast.dismiss(id);
    });
    expect(screen.queryByText('Gone soon')).toBeNull();
  });
});
