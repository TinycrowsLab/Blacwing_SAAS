'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@blackwing/ui';

import { t } from '../../lib/i18n';
import { isActive, NAV_SECTION_LABEL_KEYS, visibleNav } from '../../lib/nav';

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
    <nav aria-label={t('common.primaryNavigation')} className="flex flex-col gap-4">
      {visibleNav(roles).map(({ section, items }) => (
        <section key={section} aria-label={t(NAV_SECTION_LABEL_KEYS[section])}>
          <h2
            className={cn(
              'px-2 pb-1 text-xs font-semibold uppercase text-muted-foreground',
              collapsed && 'sr-only',
            )}
          >
            {t(NAV_SECTION_LABEL_KEYS[section])}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    title={t(item.labelKey)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active && 'bg-accent font-medium text-accent-foreground',
                    )}
                  >
                    <item.icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className={cn('truncate', collapsed && 'sr-only')}>
                      {t(item.labelKey)}
                    </span>
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
