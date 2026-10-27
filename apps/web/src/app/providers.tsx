'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ThemeProvider, Toaster } from '@blackwing/ui';

import { toastApiError } from '../lib/api-error-toast';
import { makeQueryClient } from '../lib/query-client';
import { TOAST_CONFIG } from '../lib/toast-config';

/** The only `'use client'` boundary at the root: query client, theme and toasts. */
export function Providers({ children }: { readonly children: ReactNode }): ReactNode {
  const [queryClient] = useState(() =>
    makeQueryClient({ handlers: { onError: toastApiError, onConflict: toastApiError } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {children}
        <Toaster config={TOAST_CONFIG} />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
