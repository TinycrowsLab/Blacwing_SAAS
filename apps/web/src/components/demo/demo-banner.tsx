// DEMO-STORY chrome: the banner that marks every demo page as demo mode, and the demo navigation.
import Link from 'next/link';

import { SignOutButton } from './sign-out-button';

export interface DemoBannerProps {
  readonly name: string;
  readonly email: string;
  readonly roles: readonly string[];
}

const NAV = [
  { href: '/demo', label: 'Dashboard' },
  { href: '/demo/assets', label: 'Assets' },
  { href: '/demo/requests/new', label: 'New assessment request' },
  { href: '/demo/about', label: 'What is real, what is stubbed' },
] as const;

export function DemoBanner({ name, email, roles }: DemoBannerProps) {
  return (
    <header className="border-b border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900">
      <div className="bg-amber-200 px-4 py-1 text-center text-xs font-semibold text-amber-900 dark:bg-amber-800 dark:text-amber-50">
        DEMO MODE. Lab target only (local Juice Shop). Localhost development build, not production.
      </div>
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <nav aria-label="Demo" className="flex flex-wrap gap-4 text-sm">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="underline underline-offset-2">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <span data-testid="demo-user" title={email}>
            {name} ({roles.join(', ') || 'no roles'})
          </span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
