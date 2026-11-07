'use client';

// A time in the viewer's own locale and time zone (spec §12: Intl, never the server's zone). It is formatted in the
// browser after mount, so the server's zone never shows (the ISO value stays in `dateTime` and the tooltip). A `prefix`
// (a separator such as " · ") renders with the time, so nothing dangles before it is formatted.
import { useEffect, useState } from 'react';

// The viewer's own clock (12 or 24 hours, as their locale says), the same as the run page and the conversation.
const STYLES = {
  time: { hour: 'numeric', minute: '2-digit' },
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  datetime: { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export function LocalTime({
  iso,
  style = 'time',
  className,
  prefix,
}: {
  readonly iso: string;
  readonly style?: keyof typeof STYLES;
  readonly className?: string;
  readonly prefix?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const date = new Date(iso);
    setText(
      Number.isNaN(date.getTime())
        ? null
        : new Intl.DateTimeFormat(undefined, STYLES[style]).format(date),
    );
  }, [iso, style]);
  if (text === null && prefix !== undefined) return null;
  return (
    <>
      {text === null ? null : prefix}
      <time dateTime={iso} title={iso} className={`tabular-nums ${className ?? ''}`}>
        {text ?? ' '}
      </time>
    </>
  );
}
