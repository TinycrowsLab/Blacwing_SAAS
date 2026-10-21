/** Versioned user-guide location: `<base>/<version>/<page>#<anchor>`. */
export interface DocsLinkInput {
  /** `https://` origin or a same-origin absolute path such as `/docs`. Anything else resolves to null. */
  readonly baseUrl: string;
  /** Guide version segment, for example `v1`. */
  readonly version: string;
  /** Guide page id, lowercase and hyphenated. */
  readonly page: string;
  /** Anchor on the page, lowercase and hyphenated. */
  readonly anchor: string;
}

const VERSION = /^v\d{1,4}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BASE_CHARS = 2048;

/**
 * Builds the deep link to a guide page for one version. Returns null when the base is not an https origin
 * or a same-origin path, or when any segment is not a plain slug. Callers then show the inline summary
 * without a link. Nothing user-supplied reaches the URL: the topic copy and the version come from code.
 */
export function resolveDocsLink(input: DocsLinkInput): string | null {
  const { version, page, anchor } = input;
  const base = normaliseBase(input.baseUrl);
  if (base === null) return null;
  if (!VERSION.test(version) || !SLUG.test(page) || !SLUG.test(anchor)) return null;
  return `${base}/${version}/${page}#${anchor}`;
}

function normaliseBase(raw: string): string | null {
  if (raw.length === 0 || raw.length > MAX_BASE_CHARS) return null;
  if (raw.startsWith('/')) {
    // Same-origin path only: `//host` is protocol-relative and `\` is treated as `/` by some browsers.
    if (raw.startsWith('//') || raw.includes('\\') || /[\s?#]/.test(raw)) return null;
    return raw.replace(/\/+$/, '');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '')
    return null;
  return url.href.replace(/\/+$/, '');
}
