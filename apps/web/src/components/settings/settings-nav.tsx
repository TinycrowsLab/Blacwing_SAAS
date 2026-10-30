'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import { cn } from '@blackwing/ui';

import type { SettingsNavEntry } from '../../lib/settings-nav';
import type { ReactNode } from 'react';

/** The settings sub-navigation. `entries` are already filtered by the caller's permissions. */
export function SettingsNav({
  entries,
}: {
  readonly entries: readonly Pick<SettingsNavEntry, 'key' | 'label' | 'href'>[];
}): ReactNode {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="grid gap-1">
      {entries.map((entry) => {
        const active = pathname === entry.href || pathname.startsWith(`${entry.href}/`);
        return (
          <Link
            key={entry.key}
            href={entry.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-2 text-sm text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active && 'bg-accent font-medium',
            )}
          >
            {entry.label}
          </Link>
        );
      })}
    </nav>
  );
}
