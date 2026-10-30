/** Longest display name kept from an uploaded filename (code points). The stored key never uses it as an identity. */
const FILENAME_MAX_CODE_POINTS = 100;
const FALLBACK_NAME = 'upload';

/**
 * A safe fragment of an uploaded filename for the object key (SCOPE-006, CWE-22). The result is NFKC-normalised, has no
 * control characters, path separators or other unusual characters (each run becomes one `_`), no leading dots or
 * separators, and is length-capped. An input that leaves nothing becomes `upload`. The key itself carries a server
 * upload id, so this only keeps the name readable.
 */
export function sanitiseFilename(raw: string): string {
  const normalised = raw.normalize('NFKC').replace(/\p{Cc}/gu, '');
  const replaced = normalised.replace(/[^\p{L}\p{N}._-]+/gu, '_');
  const trimmed = replaced.replace(/^[._]+/u, '').replace(/_+$/u, '');
  const capped = Array.from(trimmed).slice(0, FILENAME_MAX_CODE_POINTS).join('');
  return capped.length === 0 ? FALLBACK_NAME : capped;
}
