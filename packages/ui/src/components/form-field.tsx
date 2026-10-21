'use client';

import * as React from 'react';

import { Label } from './label';
import { cn } from '../lib/cn';

export interface FormFieldProps {
  /** Visible label text. */
  label: string;
  /** Renders the control with the generated id and aria wiring. */
  children: (control: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': true | undefined;
  }) => React.ReactNode;
  description?: string;
  /** Error message; marks the control invalid and is announced via role="alert". */
  error?: string;
  className?: string;
}

/** Label + control + description/error atoms wired with matching ids for assistive tech. */
export function FormField({ label, children, description, error, className }: FormFieldProps) {
  const id = React.useId();
  const descId = description ? `${id}-desc` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [descId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {description ? (
        <p id={descId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
