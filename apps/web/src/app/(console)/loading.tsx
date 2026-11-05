// Shown while the next page loads. It fades in only after 300 ms (`bw-delayed`), so fast navigations never flash it.
import { Skeleton } from '../../components/console/design';

import type { ReactNode } from 'react';

export default function Loading(): ReactNode {
  return (
    <div role="status" aria-label="Loading" className="flex max-w-[960px] flex-col gap-3">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-9 w-80 max-w-full" />
      <Skeleton className="h-44 w-full" />
    </div>
  );
}
