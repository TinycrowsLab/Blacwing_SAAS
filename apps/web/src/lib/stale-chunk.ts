// A page left open across a web deploy asks for a code chunk the new build no longer serves (ChunkLoadError). The fix
// is a full reload onto the new build, once: a second failure within a minute shows the error instead of looping.
const KEY = 'bw.staleChunkReloadAt';
const ONCE_MS = 60_000;
const STALE = /ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module/i;

export function isStaleChunk(error: unknown): boolean {
  if (error instanceof Error) return STALE.test(error.name) || STALE.test(error.message);
  return typeof error === 'string' && STALE.test(error);
}

/** Reloads the page when `error` is a stale chunk (at most once a minute). True when a reload was started. */
export function reloadIfStaleChunk(error: unknown): boolean {
  if (!isStaleChunk(error)) return false;
  try {
    const last = Number(window.sessionStorage.getItem(KEY) ?? '0');
    if (Date.now() - last < ONCE_MS) return false;
    window.sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // Storage blocked: still reload; the browser's own cache makes a loop unlikely.
  }
  window.location.reload();
  return true;
}
