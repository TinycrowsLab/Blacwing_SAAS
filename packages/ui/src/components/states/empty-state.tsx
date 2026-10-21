import * as React from 'react';

import { cn } from '../../lib/cn';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: string;
  description?: string;
  /** Call to action, typically a Button. */
  action?: React.ReactNode;
}

/** A list that legitimately has zero rows. Never use it for a failed or forbidden query. */
export function EmptyState({ title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      role="status"
      data-state="empty"
      className={cn('flex flex-col items-center gap-2 p-8 text-center', className)}
      {...props}
    >
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {description !== undefined && (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      )}
      {action !== undefined && <div className="mt-2">{action}</div>}
    </div>
  );
}
