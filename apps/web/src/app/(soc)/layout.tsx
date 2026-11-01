import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Login-free for a signed link, and for a SOC seat through its normal login. A link is a credential in the
// URL, so the pages must never reach a search index or leak through a referrer.
export const metadata: Metadata = {
  title: 'SOC portal',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

// Mobile-first and high contrast: the on-call analyst may be on a phone, in bright light, under pressure.
export default function SocPortalLayout({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-4 px-4 py-6 text-base leading-relaxed sm:p-6">
      <p className="text-sm font-semibold uppercase tracking-wide">Blackwing · SOC portal</p>
      {children}
    </main>
  );
}
