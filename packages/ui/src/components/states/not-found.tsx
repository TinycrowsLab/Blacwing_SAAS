import * as React from 'react';

import { cn } from '../../lib/cn';

export interface NotFoundProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: string;
  description?: string;
  /** Navigation back, typically a link-styled Button. */
  action?: React.ReactNode;
}

/** The page or record does not exist (or is not visible to the caller; the two are indistinguishable by design). */
export function NotFound({
  title = 'We could not find that page',
  description = 'It may have been moved or removed, or you may not have access to it.',
  action,
  className,
  ...props
}: NotFoundProps) {
  return (
    <div
      role="status"
      data-state="not-found"
      className={cn('flex flex-col items-center gap-2 p-8 text-center', className)}
      {...props}
    >
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
