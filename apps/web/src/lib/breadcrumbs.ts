import { type MessageKey, t } from './i18n';

// Route-derived breadcrumbs (CONSOLE-004, #264). Labels come from a per-segment map; unmapped
// segments are humanised, and opaque ids never appear raw (they become a generic label unless the
// caller resolved one through `overrides`, keyed by the crumb's href).

export interface Crumb {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

const SEGMENT_LABELS: Readonly<Record<string, MessageKey>> = {
  runs: 'breadcrumb.segment.runs',
  assets: 'breadcrumb.segment.assets',
  authorisations: 'breadcrumb.segment.authorisations',
  findings: 'breadcrumb.segment.findings',
  coverage: 'breadcrumb.segment.coverage',
  admin: 'breadcrumb.segment.admin',
  members: 'breadcrumb.segment.members',
  settings: 'breadcrumb.segment.settings',
  audit: 'breadcrumb.segment.audit',
};

/** Prefixed public ids (`run_…`) get a noun; anything else id-like gets "Details". */
const ID_PREFIX_LABELS: Readonly<Record<string, MessageKey>> = {
  run: 'breadcrumb.idPrefix.run',
  fnd: 'breadcrumb.idPrefix.fnd',
  ast: 'breadcrumb.idPrefix.ast',
  sa: 'breadcrumb.idPrefix.sa',
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

/** Own-property lookup, so a segment such as `constructor` never resolves to an inherited value. */
function own<V>(map: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function labelFor(segment: string): string {
  const known = own(SEGMENT_LABELS, segment);
  if (known !== undefined) return t(known);
  const prefixed = PREFIXED_ID.exec(segment);
  if (prefixed !== null) {
    const noun = own(ID_PREFIX_LABELS, prefixed[1] ?? '');
    return noun === undefined ? t('breadcrumb.details') : t(noun);
  }
  if (UUID.test(segment) || NUMERIC.test(segment)) return t('breadcrumb.details');
  const words = segment.replace(/[-_]+/g, ' ').trim();
  return words === '' ? t('breadcrumb.details') : words.charAt(0).toUpperCase() + words.slice(1);
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
