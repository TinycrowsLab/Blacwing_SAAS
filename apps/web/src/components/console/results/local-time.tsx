'use client';

// A time in the viewer's own locale and time zone (spec §12: Intl, never the server's zone). It is formatted in the
// browser after mount, so the server's zone never shows (the ISO value stays in `dateTime` and the tooltip).
import { useEffect, useState } from 'react';

const STYLES = {
  time: { hour: '2-digit', minute: '2-digit' },
  date: { day: 'numeric', month: 'short', year: 'numeric' },
  datetime: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export function LocalTime({
  iso,
  style = 'time',
  className,
}: {
  readonly iso: string;
  readonly style?: keyof typeof STYLES;
  readonly className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const date = new Date(iso);
    setText(Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat(undefined, STYLES[style]).format(date));
  }, [iso, style]);
  return (
    <time dateTime={iso} title={iso} className={`tabular-nums ${className ?? ''}`}>
      {text ?? '\u00a0'}
    </time>
  );
}
