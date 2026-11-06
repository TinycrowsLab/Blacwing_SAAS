'use client';

// A date or time in the reader's own locale and time zone. The server cannot know either, so the first render (server
// and hydration) shows the ISO date and the reader's format follows at once: no hydration mismatch.
import { useSyncExternalStore } from 'react';

/** "2026-11-06": the date part of an ISO timestamp. */
const ISO_DATE_LENGTH = 10;

const noSubscribe = (): (() => void) => () => undefined;

export function LocalTime({ iso, format }: { readonly iso: string; readonly format: (iso: string) => string }) {
  const text = useSyncExternalStore(
    noSubscribe,
    () => format(iso),
    () => iso.slice(0, ISO_DATE_LENGTH),
  );
  return <time dateTime={iso}>{text}</time>;
}

/** "1:32 pm" today, "6 Nov 2026, 1:32 pm" on another day: the one way the order and the plan write a moment. */
export const momentText = (iso: string): string => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    today ? { hour: 'numeric', minute: '2-digit' } : { dateStyle: 'medium', timeStyle: 'short' },
  ).format(d);
};

/** A moment for a server component (it cannot hand a format function to the client). */
export function LocalMoment({ iso }: { readonly iso: string }) {
  return <LocalTime iso={iso} format={momentText} />;
}
