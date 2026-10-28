import { SIGNUP_SLUG_MAX, SIGNUP_SLUG_MIN } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

/** Letters that Unicode decomposition does not reduce to ASCII. */
const TRANSLITERATIONS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ð: 'd',
  đ: 'd',
  ł: 'l',
  þ: 'th',
};

/** Combining marks left behind by NFKD (accents become separate code points). */
const TRANSLITERATED = new RegExp(`[${Object.keys(TRANSLITERATIONS).join('')}]`, 'g');
const COMBINING_MARKS = /\p{M}/gu;
const NON_SLUG = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;

/**
 * The slug base of an organisation name (TENANT-004 requirement 6): NFKD with accents dropped, a few
 * letters transliterated, lower case, every run of other characters one hyphen, at most 40 characters.
 * A name with too few Latin letters or digits (for example one in another script) is refused here, at
 * request time, rather than given an arbitrary slug: `ValidationError`, 422.
 */
export function slugBase(orgName: string): string {
  const folded = orgName
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(TRANSLITERATED, (letter) => TRANSLITERATIONS[letter] ?? letter)
    .replace(NON_SLUG, '-')
    .replace(EDGE_HYPHENS, '');
  const slug = folded.slice(0, SIGNUP_SLUG_MAX).replace(EDGE_HYPHENS, '');
  if (slug.length < SIGNUP_SLUG_MIN) {
    throw new ValidationError('organisation name yields no usable slug', {
      detail: `orgName must contain at least ${String(SIGNUP_SLUG_MIN)} letters or digits (a-z, 0-9) once accents are removed`,
    });
  }
  return slug;
}

/**
 * Candidate number `attempt` (1-based) for `base`: the base itself, then `-2`, `-3`, ... The base is cut
 * so the whole slug stays within 40 characters.
 */
export function slugCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${String(attempt)}`;
  return `${base.slice(0, SIGNUP_SLUG_MAX - suffix.length).replace(EDGE_HYPHENS, '')}${suffix}`;
}
