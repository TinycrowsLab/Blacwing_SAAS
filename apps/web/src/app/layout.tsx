import './globals.css';
import { THEME_INIT_SCRIPT } from '@blackwing/ui';

import { Providers } from './providers';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: { default: 'Blackwing', template: '%s | Blackwing' },
  description: 'Authorised, human-gated autonomous security assessments.',
  icons: { icon: '/brand/crow-shield.png', apple: '/brand/crow-shield.png' },
};

export default function RootLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    // suppressHydrationWarning: next-themes sets the theme class before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
