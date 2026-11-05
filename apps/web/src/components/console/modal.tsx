'use client';

// A native <dialog> opened modally: focus trap, Escape and backdrop come from the browser. The element with
// `data-autofocus` inside gets focus on open (the Stop dialog focuses Stop: stopping is the safe direction).
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
    if (open && !dialog.open) {
      dialog.showModal();
      // showModal focuses the first control; a dialog names its safe default with data-autofocus instead.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      className={`m-auto max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] overflow-auto rounded-[20px] border border-border bg-card p-0 text-foreground shadow-pop backdrop:bg-[rgba(23,21,15,0.45)] backdrop:backdrop-blur-[2px] ${className}`}
    >
      {open ? children : null}
    </dialog>
  );
}
