// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NavigationGuardDialog } from './navigation-guard-dialog';
import { useUnsavedChangesGuard } from './use-unsaved-changes-guard';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

function Page({ dirty }: { readonly dirty: boolean }) {
  const guard = useUnsavedChangesGuard({ when: dirty });
  return (
    <>
      <a href="/scoping/next">Next page</a>
      <a href="/scoping">Same page</a>
      <a href="https://example.com/away">External</a>
      <a href="/new-tab" target="_blank">
        New tab
      </a>
      <NavigationGuardDialog guard={guard} />
    </>
  );
}

beforeEach(() => {
  push.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('useUnsavedChangesGuard', () => {
  it('holds an in-app link click and opens the dialog while the form is dirty', () => {
    render(<Page dirty />);
    const link = screen.getByRole('link', { name: 'Next page' });
    const notPrevented = fireEvent.click(link);
    expect(notPrevented).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('Cancel keeps the form and stays on the page', () => {
    render(<Page dirty />);
    fireEvent.click(screen.getByRole('link', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('Confirm discards and navigates to the pending path', () => {
    render(<Page dirty />);
    fireEvent.click(screen.getByRole('link', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(push).toHaveBeenCalledWith('/scoping/next');
  });

  it('lets the browser handle a clean form, external, same-page and new-tab links', () => {
    render(<Page dirty={false} />);
    expect(fireEvent.click(screen.getByRole('link', { name: 'Next page' }))).toBe(true);
    cleanup();
    window.history.pushState({}, '', '/scoping');
    try {
      render(<Page dirty />);
      expect(fireEvent.click(screen.getByRole('link', { name: 'External' }))).toBe(true);
      expect(fireEvent.click(screen.getByRole('link', { name: 'Same page' }))).toBe(true);
      expect(fireEvent.click(screen.getByRole('link', { name: 'New tab' }))).toBe(true);
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('ignores modified clicks (new tab shortcuts)', () => {
    render(<Page dirty />);
    const link = screen.getByRole('link', { name: 'Next page' });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sets the native beforeunload prompt only while dirty', () => {
    const { unmount } = render(<Page dirty />);
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);
    unmount();

    render(<Page dirty={false} />);
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it('removes its listeners when the form becomes clean', () => {
    const { rerender } = render(<Page dirty />);
    rerender(<Page dirty={false} />);
    expect(fireEvent.click(screen.getByRole('link', { name: 'Next page' }))).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(unload);
    });
    expect(unload.defaultPrevented).toBe(false);
  });

  it('exposes a hook whose open state is false until a navigation is held', () => {
    const { result } = renderHook(() => useUnsavedChangesGuard({ when: true }));
    expect(result.current.open).toBe(false);
  });
});
