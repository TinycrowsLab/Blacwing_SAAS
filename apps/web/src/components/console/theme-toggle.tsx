'use client';

// Light/dark switch for the top bar (no System option: the console is light unless dark is chosen).
import { useEffect, useState } from 'react';

import { useTheme } from '@blackwing/ui';

import { Icon } from './design';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const dark = mounted && resolvedTheme === 'dark';
  return (
    <button
      type="button"
      onClick={() => {
        setTheme(dark ? 'light' : 'dark');
      }}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="flex size-9 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus"
    >
      <Icon name={dark ? 'sun' : 'moon'} size={18} />
      <span className="sr-only">{dark ? 'Switch to light theme' : 'Switch to dark theme'}</span>
    </button>
  );
}
