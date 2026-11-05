'use client';

import { ThemeProvider } from '@blackwing/ui';

import type { ReactNode } from 'react';

/** The only `'use client'` boundary at the root: the light/dark theme (light unless dark is chosen). */
export function Providers({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <ThemeProvider defaultTheme="light" enableSystem={false}>
      {children}
    </ThemeProvider>
  );
}
