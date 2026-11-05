import Link from 'next/link';

import { buttonClass } from '../components/console/design';

import type { ReactNode } from 'react';

export default function NotFound(): ReactNode {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-bg px-4 text-center text-text">
      <span className="flex size-12 items-center justify-center rounded-[12px] bg-gold-soft shadow-[inset_0_0_0_1px_var(--gold-line)]">
        <img src="/brand/crow-shield.png" alt="" width={26} height={26} className="object-contain" />
      </span>
      <h1 className="m-0 text-[24px] font-semibold leading-8">We couldn&apos;t find that page</h1>
      <p className="m-0 max-w-sm text-[14px] leading-6 text-muted-foreground">
        The link may be old, or the page has moved. Everything you have is still on Home.
      </p>
      <Link href="/" className={buttonClass('primary')}>
        Go to Home
      </Link>
    </main>
  );
}
