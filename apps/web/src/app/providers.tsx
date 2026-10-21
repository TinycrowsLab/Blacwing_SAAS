'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ThemeProvider } from '@blackwing/ui';

import { Toaster } from '../components/toaster';
import { makeQueryClient } from '../lib/query-client';

/** The only `'use client'` boundary at the root: query client, theme and toasts. */
export function Providers({ children }: { readonly children: ReactNode }): ReactNode {
  const [queryClient] = useState(() => makeQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Toaster>{children}</Toaster>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
