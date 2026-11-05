'use client';

// The 64 px icon rail. The active item follows the route, so the layout never needs the page.
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { Icon, type IconName } from './design';

interface RailItem {
  readonly label: string;
  readonly icon: IconName;
  readonly href: string;
  readonly match: (path: string) => boolean;
}

const RAIL: readonly RailItem[] = [
  { label: 'Dashboard', icon: 'grid', href: '/', match: (p) => p === '/' },
  {
    label: 'Assets',
    icon: 'assets',
    href: '/assets',
    match: (p) => p.startsWith('/assets'),
  },
  {
    label: 'New assessment',
    icon: 'assessments',
    href: '/requests/new',
    match: (p) => p.startsWith('/requests') || p.startsWith('/runs'),
  },
  {
    label: 'Approvals',
    icon: 'approvals',
    href: '/#waiting',
    match: (p) => p.startsWith('/approvals'),
  },
  {
    label: 'Findings',
    icon: 'findings',
    href: '/findings',
    match: (p) => p.startsWith('/findings'),
  },
  {
    label: 'Audit ledger',
    icon: 'ledger',
    href: '/audit',
    match: (p) => p.startsWith('/audit'),
  },
  {
    label: 'About',
    icon: 'info',
    href: '/about',
    match: (p) => p.startsWith('/about'),
  },
];

export function Rail({ pendingGate2 }: { readonly pendingGate2: number }) {
  const path = usePathname();
  return (
    <nav
      aria-label="Main"
      className="hidden flex-col items-center gap-1.5 border-r border-border bg-surface py-3.5 md:flex"
    >
      {RAIL.map((item) => {
        const isActive = item.match(path);
        const base = 'flex size-10 items-center justify-center rounded-[10px]';
        return (
          <Link
            key={item.label}
            href={item.href}
            title={item.label}
            aria-current={isActive ? 'page' : undefined}
            className={`${base} relative ${isActive ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
          >
            <Icon name={item.icon} size={19} />
            {item.icon === 'approvals' && pendingGate2 > 0 ? (
              <span
                aria-hidden="true"
                className="absolute right-[5px] top-[5px] size-2 rounded-full bg-warn motion-safe:animate-[bwpulse_1.4s_ease-in-out_infinite]"
              />
            ) : null}
            <span className="sr-only">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
