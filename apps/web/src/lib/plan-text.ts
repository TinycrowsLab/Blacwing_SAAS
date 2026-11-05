// Deterministic copy templates (experience spec §3.4, §6.2, §7): the plan read-back, the results headline and the
// decision title. Never model-written. Pure functions over API values.

export type PlanField = 'host' | 'objective' | 'intrusiveness' | 'paths' | 'accounts' | 'limits' | 'release';

/** A run of the paragraph; a `field` segment is a value the person can click to change. */
export type PlanSegment = { readonly text: string; readonly field?: PlanField };

export interface PlanInput {
  readonly host: string;
  readonly objective: string;
  readonly intrusiveness: 'passive' | 'active_safe';
  readonly excludedPaths: readonly string[];
  readonly roles: readonly string[];
  readonly minutes: number;
  readonly requests: number;
  readonly costUsd: number;
  readonly releaseProven: 'hold' | 'auto';
}

const LOCALE = 'en-US';
const list = (items: readonly string[]): string =>
  new Intl.ListFormat(LOCALE, { style: 'long', type: 'conjunction' }).format(items);
const count = (n: number, one: string, many: string): string =>
  `${n.toLocaleString(LOCALE)} ${n === 1 ? one : many}`;
export const usd = (n: number): string =>
  n.toLocaleString(LOCALE, { style: 'currency', currency: 'USD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2 });

/** "Look for injection and APIs. Focus on checkout." becomes "injection and APIs". */
export function objectivePhrase(objective: string): string {
  const first = (objective.trim().split(/(?<=\.)\s/)[0] ?? '').replace(/^look for\s+/i, '').replace(/\.$/, '');
  return first === '' ? 'the OWASP Top 10' : first.charAt(0).toLowerCase() + first.slice(1);
}

export function limitsPhrase(p: Pick<PlanInput, 'minutes' | 'requests' | 'costUsd'>): string {
  return `${count(p.minutes, 'minute', 'minutes')}, ${count(p.requests, 'request', 'requests')} or ${usd(p.costUsd)} of model spend`;
}

export function planSegments(p: PlanInput): PlanSegment[] {
  const gentle = p.intrusiveness === 'active_safe';
  return [
    { text: 'We will audit ' },
    { text: p.host, field: 'host' },
    { text: ' for ' },
    { text: objectivePhrase(p.objective), field: 'objective' },
    { text: ". Claude's agents will " },
    { text: gentle ? 'probe gently' : 'only look, never touch', field: 'intrusiveness' },
    {
      text: `: ${gentle ? 'crafted read requests that should not change data' : 'GET, HEAD and OPTIONS only'}. Anything that would change data waits for your yes. They will stay out of `,
    },
    { text: p.excludedPaths.length === 0 ? 'nothing extra' : list(p.excludedPaths), field: 'paths' },
    { text: ' and test as ' },
    {
      text:
        p.roles.length === 0
          ? 'a visitor'
          : `${count(p.roles.length, 'signed-in role', 'signed-in roles')}, ${list(p.roles)}`,
      field: 'accounts',
    },
    { text: '. We stop at ' },
    { text: limitsPhrase(p), field: 'limits' },
    { text: ', whichever comes first. Anything Claude proves ' },
    {
      text: p.releaseProven === 'hold' ? 'waits for your release' : 'is released to the report automatically',
      field: 'release',
    },
    { text: '.' },
  ];
}

export const planText = (p: PlanInput): string =>
  planSegments(p)
    .map((s) => s.text)
    .join('');

/** Results H1 (§7): "Claude proved 3 issues. Fix the critical one first." */
export function resultsHeadline(severities: readonly string[]): string {
  const n = severities.length;
  if (n === 0) return 'No issues were proven.';
  const head = `Claude proved ${count(n, 'issue', 'issues')}.`;
  const crit = severities.filter((s) => s === 'critical').length;
  if (crit > 0) return `${head} Fix the critical ${crit === 1 ? 'one' : 'ones'} first.`;
  const high = severities.filter((s) => s === 'high').length;
  if (high > 0) return `${head} Start with the high-severity ${high === 1 ? 'one' : 'ones'}.`;
  return head;
}

const ID_SEGMENT = /^(\d+|[0-9a-f-]{16,})$/i;

/** "Allow a checkout request?" from `POST /rest/basket/7/checkout` (the last path segment that is not an id). */
export function decisionTitle(method: string, url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // A bare path is fine as it is.
  }
  const word = path
    .split('/')
    .filter((s) => s !== '' && !ID_SEGMENT.test(s))
    .at(-1)
    ?.replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
  const noun = word === undefined || word === '' ? method.toUpperCase() : word;
  return `Allow ${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun} request?`;
}
