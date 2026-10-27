// Route-derived breadcrumbs (CONSOLE-004, #264). Labels come from a per-segment map; unmapped
// segments are humanised, and opaque ids never appear raw (they become a generic label unless the
// caller resolved one through `overrides`, keyed by the crumb's href).

export interface Crumb {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

const SEGMENT_LABELS: Readonly<Record<string, string>> = {
  runs: 'Runs',
  assets: 'Assets',
  authorisations: 'Authorisations',
  findings: 'Findings',
  coverage: 'Coverage',
  admin: 'Admin',
  members: 'Members',
  settings: 'Settings',
  audit: 'Audit log',
};

/** Prefixed public ids (`run_…`) get a noun; anything else id-like gets "Details". */
const ID_PREFIX_LABELS: Readonly<Record<string, string>> = {
  run: 'Run',
  fnd: 'Finding',
  ast: 'Asset',
  sa: 'Authorisation',
};
const PREFIXED_ID = /^([a-z]{2,4})_[A-Za-z0-9]{6,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const MAX_SEGMENTS = 8;

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function labelFor(segment: string): string {
  const known = SEGMENT_LABELS[segment];
  if (known !== undefined) return known;
  const prefixed = PREFIXED_ID.exec(segment);
  if (prefixed !== null) return ID_PREFIX_LABELS[prefixed[1] ?? ''] ?? 'Details';
  if (UUID.test(segment) || NUMERIC.test(segment)) return 'Details';
  const words = segment.replace(/[-_]+/g, ' ').trim();
  return words === '' ? 'Details' : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Trail for `pathname`; the last crumb is current. "/" has no trail. */
export function breadcrumbsFor(
  pathname: string,
  overrides: Readonly<Record<string, string>> = {},
): readonly Crumb[] {
  const segments =
    pathname
      .split('?')[0]
      ?.split('#')[0]
      ?.split('/')
      .filter((s) => s !== '')
      .slice(0, MAX_SEGMENTS) ?? [];
  const crumbs: Crumb[] = [];
  let href = '';
  for (const raw of segments) {
    href += `/${raw}`;
    crumbs.push({
      label: overrides[href] ?? labelFor(safeDecode(raw)),
      href,
      current: false,
    });
  }
  return crumbs.map((crumb, i) => ({ ...crumb, current: i === crumbs.length - 1 }));
}
