'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@blackwing/ui';

import { breadcrumbsFor } from '../../lib/breadcrumbs';

import type { ReactNode } from 'react';

/** Breadcrumb trail for the current route; `labels` maps a crumb href to a loader-resolved label. */
export function Breadcrumbs({
  labels,
}: {
  readonly labels?: Readonly<Record<string, string>>;
}): ReactNode {
  const crumbs = breadcrumbsFor(usePathname(), labels);
  if (crumbs.length === 0) return null;
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb) => (
          <React.Fragment key={crumb.href}>
            <BreadcrumbItem>
              {crumb.current ? (
                <BreadcrumbPage className="max-w-48 truncate" title={crumb.label}>
                  {crumb.label}
                </BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link href={crumb.href} className="max-w-48 truncate" title={crumb.label}>
                    {crumb.label}
                  </Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {!crumb.current && <BreadcrumbSeparator />}
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
