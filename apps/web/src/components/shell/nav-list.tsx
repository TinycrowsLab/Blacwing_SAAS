'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@blackwing/ui';

import { isActive, visibleNav } from '../../lib/nav';

import type { ReactNode } from 'react';

/** The role-gated navigation. `collapsed` shows icons only (labels stay for assistive tech). */
export function NavList({
  roles,
  collapsed = false,
}: {
  readonly roles: readonly string[];
  readonly collapsed?: boolean;
}): ReactNode {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-4">
      {visibleNav(roles).map(({ section, items }) => (
        <section key={section} aria-label={section}>
          <h2
            className={cn(
              'px-2 pb-1 text-xs font-semibold uppercase text-muted-foreground',
              collapsed && 'sr-only',
            )}
          >
            {section}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    title={item.label}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active && 'bg-accent font-medium text-accent-foreground',
                    )}
                  >
                    <item.icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}
