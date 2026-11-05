'use client';

// A native <dialog> opened modally: focus trap, Escape and backdrop come from the browser.
import { type ReactNode, useEffect, useRef } from 'react';

export function Modal({
  open,
  onClose,
  label,
  children,
  className = '',
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      className={`m-auto w-[calc(100vw-32px)] overflow-hidden rounded-[20px] border border-border bg-card p-0 text-foreground shadow-[0_30px_80px_rgba(0,0,0,0.35)] backdrop:bg-[rgba(22,23,29,0.55)] ${className}`}
    >
      {open ? children : null}
    </dialog>
  );
}
