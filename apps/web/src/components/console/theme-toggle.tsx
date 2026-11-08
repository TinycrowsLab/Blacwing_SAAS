'use client';

// Light/dark switch. Until someone picks one, the console follows the device's theme (System).
import { useEffect, useState } from 'react';

import { useTheme } from '@blackwing/ui';

import { Icon } from './design';

/** [isDark, toggle]. `isDark` is false until mounted, so the server and the first client render agree. */
export function useDarkTheme(): readonly [boolean, () => void] {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const dark = mounted && resolvedTheme === 'dark';
  return [
    dark,
    () => {
      setTheme(dark ? 'light' : 'dark');
    },
  ] as const;
}

export type ThemeChoice = 'light' | 'dark' | 'system';

/** [choice, set]: the stored choice (System until one is picked). `choice` is null until mounted (no hydration mismatch). */
export function useThemeChoice(): readonly [ThemeChoice | null, (choice: ThemeChoice) => void] {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const choice: ThemeChoice | null = !mounted ? null : theme === 'light' || theme === 'dark' ? theme : 'system';
  return [choice, setTheme] as const;
}

export function ThemeToggle() {
  const [dark, toggle] = useDarkTheme();
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      className="flex size-10 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
    >
      <Icon name={dark ? 'sun' : 'moon'} size={18} />
      <span className="sr-only">{label}</span>
    </button>
  );
}
