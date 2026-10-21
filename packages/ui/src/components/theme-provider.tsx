'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import * as React from 'react';

/** localStorage key of the persisted choice (next-themes default); client-only, never sent to a server. */
export const THEME_STORAGE_KEY = 'bw-theme';

export type ThemeProviderProps = Omit<
  React.ComponentProps<typeof NextThemesProvider>,
  | 'attribute'
  | 'defaultTheme'
  | 'enableSystem'
  | 'disableTransitionOnChange'
  | 'storageKey'
  | 'themes'
>;

/**
 * Class-strategy theming: sets `.dark` on `<html>` (tokens.css), defaults to the OS preference and
 * persists to `bw-theme`. next-themes injects the pre-hydration script (no flash) and falls back to
 * `system` when localStorage is blocked or full. Mount once in apps/web `providers.tsx`; put
 * `suppressHydrationWarning` on `<html>`.
 */
export function ThemeProvider(props: ThemeProviderProps): React.JSX.Element {
  return (
    <NextThemesProvider
      {...props}
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey={THEME_STORAGE_KEY}
      themes={['light', 'dark']}
    />
  );
}
