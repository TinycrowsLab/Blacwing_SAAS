'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

/** What the guard dialog needs: whether it is open and the user's answer. */
export interface UnsavedChangesGuard {
  /** A navigation is waiting for the user's answer. */
  readonly open: boolean;
  /** Discard the changes and continue to the pending in-app page. */
  readonly confirm: () => void;
  /** Keep the form and stay where it is. */
  readonly cancel: () => void;
}

/** Whether a click should be left to the browser: modified, non-primary, new-tab or foreign-origin links. */
function isPlainInAppLink(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(target instanceof HTMLAnchorElement)) return null;
  if (target.target !== '' && target.target !== '_self') return null;
  if (target.origin !== globalThis.location.origin) return null;
  return target;
}

/**
 * Guards a dirty form against accidental loss (CONSOLE-010). While `when` is true:
 * - a click on an in-app link is held and the guard reports `open` until the user confirms or cancels;
 * - a hard reload or tab close shows the browser's native "leave site?" prompt (custom text is not allowed).
 *
 * Limits: App Router has no route blocker, so programmatic `router.push` and browser back/forward are not
 * intercepted. Clear `when` (reset the form) before a save redirects, so the redirect is not blocked.
 */
export function useUnsavedChangesGuard({ when }: { readonly when: boolean }): UnsavedChangesGuard {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (!when) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    globalThis.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      globalThis.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [when]);

  useEffect(() => {
    if (!when) return undefined;
    // Capture phase, so the click is held before Next's <Link> navigates.
    const onClick = (event: MouseEvent): void => {
      const anchor = isPlainInAppLink(event);
      if (anchor === null) return;
      const { pathname, search } = globalThis.location;
      if (anchor.pathname === pathname && anchor.search === search) return;
      event.preventDefault();
      setPending(`${anchor.pathname}${anchor.search}${anchor.hash}`);
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
    };
  }, [when]);

  const cancel = useCallback(() => {
    setPending(null);
  }, []);

  const confirm = useCallback(() => {
    const target = pending;
    setPending(null);
    if (target !== null) router.push(target);
  }, [pending, router]);

  return { open: pending !== null, confirm, cancel };
}
