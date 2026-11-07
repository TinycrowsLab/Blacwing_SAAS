// Shared by server pages, so it lives outside the client module (hash-focus.tsx) that sets the attribute.
/** The highlight a hash target shows while `data-highlight` is set (a soft gold wash that fades out). */
export const HIGHLIGHT_CLASS =
  'transition-[background-color,box-shadow] duration-700 data-[highlight]:bg-gold-soft data-[highlight]:shadow-[0_0_0_3px_var(--color-gold-line)]';
