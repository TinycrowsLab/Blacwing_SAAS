'use client';

// A link to "/settings#webhook" or "/ledger#verify" lands on that part of the page: it is scrolled into view (the
// console scrolls inside its own column, which the browser's own anchor jump does not always reach) and marked for a
// moment with `data-highlight`, which the target styles. Also on a hash change within the page.
import { useEffect } from 'react';

const HIGHLIGHT_MS = 2400;

export function HashFocus() {
  useEffect(() => {
    let timer = 0;
    const go = (): void => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const el = id === '' ? null : document.getElementById(id);
      if (el === null) return;
      const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
      el.setAttribute('data-highlight', '');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        el.removeAttribute('data-highlight');
      }, HIGHLIGHT_MS);
    };
    go();
    window.addEventListener('hashchange', go);
    return () => {
      window.removeEventListener('hashchange', go);
      window.clearTimeout(timer);
    };
  }, []);
  return null;
}

/** The highlight a hash target shows while `data-highlight` is set (a soft gold wash that fades out). */
export const HIGHLIGHT_CLASS = 'transition-[background-color,box-shadow] duration-700 data-[highlight]:bg-gold-soft data-[highlight]:shadow-[0_0_0_3px_var(--color-gold-line)]';
