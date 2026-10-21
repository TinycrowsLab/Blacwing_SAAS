import './globals.css';
import { Providers } from './providers';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: { default: 'Blackwing', template: '%s | Blackwing' },
  description: 'Blackwing web console',
};

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    // suppressHydrationWarning: next-themes sets the theme class before hydration (CONSOLE-003).
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
