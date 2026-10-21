'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';

import { Toaster } from '../components/toaster';
import { makeQueryClient } from '../lib/query-client';

/** The only `'use client'` boundary at the root: query client, theme and toasts. */
export function Providers({ children }: { readonly children: ReactNode }): ReactNode {
  const [queryClient] = useState(() => makeQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <Toaster>{children}</Toaster>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
