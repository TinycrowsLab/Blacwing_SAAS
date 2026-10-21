'use client';

import { ShieldAlert } from 'lucide-react';
import * as React from 'react';

import { cn } from '../../lib/cn';

export interface PermissionDeniedProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The permission the server says is missing, when it names one. */
  permission?: string | undefined;
  /** Whom to contact for access, e.g. "your organisation owner". */
  contact?: string | undefined;
  /** Called once when the state is shown (metrics: `permission_denied_view`). */
  onShown?: (() => void) | undefined;
}

/**
 * Rendered as a reaction to a server 403 (or a route the role may not view). The client never decides
 * access: this component only explains a decision the server already made.
 */
export function PermissionDenied({
  permission,
  contact = 'your organisation administrator',
  onShown,
  className,
  ...props
}: PermissionDeniedProps) {
  const shown = React.useRef(onShown);
  shown.current = onShown;
  React.useEffect(() => {
    shown.current?.();
  }, []);
  return (
    <div
      role="alert"
      data-state="permission-denied"
      className={cn('flex flex-col items-center gap-2 p-8 text-center', className)}
      {...props}
    >
      <ShieldAlert aria-hidden="true" className="h-8 w-8 text-warning" />
      <h2 className="text-base font-semibold text-foreground">You do not have access</h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        {permission === undefined
          ? 'Your role does not include the permission this view needs.'
          : `Your role does not include the permission ${permission}.`}{' '}
        Contact {contact} to request access.
      </p>
    </div>
  );
}
