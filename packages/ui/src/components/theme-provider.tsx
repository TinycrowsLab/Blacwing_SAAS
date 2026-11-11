'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import * as React from 'react';

import { THEME_STORAGE_KEY } from '../theme-init';

export type ThemeProviderProps = Omit<
  React.ComponentProps<typeof NextThemesProvider>,
  'attribute' | 'disableTransitionOnChange' | 'storageKey' | 'themes'
>;

/**
 * Class-strategy theming: sets `.dark` on `<html>` (tokens.css), defaults to the OS preference (apps may override `defaultTheme` and `enableSystem`) and
 * persists to `bw-theme`. next-themes injects the pre-hydration script (no flash) and falls back to
 * `system` when localStorage is blocked or full. Mount once in apps/web `providers.tsx`; put
 * `suppressHydrationWarning` on `<html>`.
 */
export function ThemeProvider({
  defaultTheme = 'system',
  enableSystem = true,
  ...props
}: ThemeProviderProps): React.JSX.Element {
  return (
    <NextThemesProvider
      {...props}
      attribute="class"
      defaultTheme={defaultTheme}
      enableSystem={enableSystem}
      disableTransitionOnChange
      storageKey={THEME_STORAGE_KEY}
      themes={['light', 'dark']}
    />
  );
}
