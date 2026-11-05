'use client';

// DEMO-STORY: the 64 px icon rail. The active item follows the route, so the layout never needs the page.
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
  { label: 'Dashboard', icon: 'grid', href: '/demo', match: (p) => p === '/demo' },
  {
    label: 'Assets',
    icon: 'assets',
    href: '/demo/assets',
    match: (p) => p.startsWith('/demo/assets'),
  },
  {
    label: 'New assessment',
    icon: 'assessments',
    href: '/demo/requests/new',
    match: (p) => p.startsWith('/demo/requests') || p.startsWith('/demo/runs'),
  },
  {
    label: 'Approvals',
    icon: 'approvals',
    href: '/demo#waiting',
    match: (p) => p.startsWith('/demo/approvals'),
  },
  {
    label: 'Findings',
    icon: 'findings',
    href: '/demo/findings',
    match: (p) => p.startsWith('/demo/findings'),
  },
  {
    label: 'Audit ledger',
    icon: 'ledger',
    href: '/demo/audit',
    match: (p) => p.startsWith('/demo/audit'),
  },
  {
    label: 'About the demo',
    icon: 'info',
    href: '/demo/about',
    match: (p) => p.startsWith('/demo/about'),
  },
];

export function DemoRail() {
  const path = usePathname();
  return (
    <nav
      aria-label="Demo"
      className="flex flex-col items-center gap-1.5 border-r border-border bg-surface py-3.5"
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
            className={`${base} ${isActive ? 'bg-primary-soft text-primary' : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground'}`}
          >
            <Icon name={item.icon} size={19} />
            <span className="sr-only">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
