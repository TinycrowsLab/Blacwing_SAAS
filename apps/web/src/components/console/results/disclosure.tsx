// A collapsed-by-default section. Native <details>/<summary>, so it opens without JavaScript and works in a server
// component as well as a client one. The reference-style, lower-priority parts of the results page (what was not
// tested, the full decision log, the run's limit presets) live inside one, so the page stays short and calm and the
// detail is one click away. Nothing is removed — only folded.
import { Icon } from '../design';

import type { ReactNode } from 'react';

const CHEVRON_HEADING = 16;
const CHEVRON_INLINE = 14;

export function Disclosure({
  title,
  hint = null,
  defaultOpen = false,
  heading = true,
  children,
}: {
  readonly title: string;
  /** A short muted note beside the title, both open and closed (e.g. a count). */
  readonly hint?: string | null;
  readonly defaultOpen?: boolean;
  /** Render the summary as a section heading (an h2). Off for a sub-control folded inside another section. */
  readonly heading?: boolean;
  readonly children: ReactNode;
}) {
  const label = heading ? (
    <h2 className="m-0 text-[17px] font-semibold text-foreground">{title}</h2>
  ) : (
    <span className="text-[13px] font-medium text-foreground">{title}</span>
  );
  return (
    <details
      open={defaultOpen}
      className={`group flex flex-col ${heading ? 'rounded-[14px] border border-border bg-card px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]' : ''}`}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-1 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus [&::-webkit-details-marker]:hidden">
        <Icon
          name="chevron"
          size={heading ? CHEVRON_HEADING : CHEVRON_INLINE}
          className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
        {label}
        {hint === null ? null : (
          <span className="text-[12.5px] font-normal text-muted-foreground">{hint}</span>
        )}
      </summary>
      <div className={heading ? 'mt-2' : 'mt-2.5'}>{children}</div>
    </details>
  );
}
