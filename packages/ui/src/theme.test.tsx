// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModeToggle, THEME_STORAGE_KEY, ThemeProvider } from './index';

function stubMatchMedia(dark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string): Partial<MediaQueryList> => ({
    matches: query.includes('dark') ? dark : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  stubMatchMedia(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ModeToggle', () => {
  it('lists Light, Dark and System and applies the choice to <html> and bw-theme', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ModeToggle />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(screen.getByRole('menuitem', { name: 'Light' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'System' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Dark' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
    await user.click(screen.getByRole('menuitem', { name: 'Light' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('bw-theme')).toBe('light');
  }, 30_000);

  it('restores a persisted choice', () => {
    localStorage.setItem('bw-theme', 'dark');
    render(
      <ThemeProvider>
        <ModeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('follows the OS preference by default (system)', () => {
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <ModeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not throw and falls back to system when localStorage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() =>
      render(
        <ThemeProvider>
          <ModeToggle />
        </ThemeProvider>,
      ),
    ).not.toThrow();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('theme stylesheet', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/index.css'), 'utf8');
  it('binds dark: to the .dark class and honours forced-colors and reduced motion', () => {
    expect(css).toContain('@custom-variant dark');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
