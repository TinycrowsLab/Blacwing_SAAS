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
