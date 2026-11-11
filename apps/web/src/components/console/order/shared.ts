// Small pure pieces the order, the plan and Targets share (experience spec §3.3, §3.4, §10.4).
import type { Asset } from '../../../lib/schemas';

/** True while typing in a field: single-key shortcuts (numbers, N) must not fire then. */
export const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLInputElement && !['radio', 'checkbox', 'button', 'submit'].includes(target.type)));

/** Every mutation tells the sidebar to refresh at once. */
export const refreshSidebar = (): void => {
  window.dispatchEvent(new Event('bw:refresh'));
};

/** What Blackwing looks for (Q3). `phrase` composes the objective and must start lower-case (it is read mid-sentence). */
export const FOCUS_CHIPS = [
  { key: 'access', label: 'Who can see whose data', hint: 'access control, IDOR', phrase: 'broken access control' },
  { key: 'login', label: 'Login and sessions', hint: 'sign-in, tokens, session handling', phrase: 'weak login and session handling' },
  { key: 'injection', label: 'Injection', hint: 'SQL, NoSQL, templates', phrase: 'injection flaws' },
  { key: 'apis', label: 'APIs', hint: 'endpoints, methods, data exposure', phrase: 'weak spots in the APIs' },
  {
    key: 'misconfig',
    label: 'Misconfiguration and exposed files',
    hint: 'headers, debug pages, backups',
    phrase: 'misconfiguration and exposed files',
  },
  { key: 'broad', label: 'A broad OWASP Top 10 sweep', hint: 'a bit of everything', phrase: 'the OWASP Top 10' },
] as const;
export type FocusKey = (typeof FOCUS_CHIPS)[number]['key'];
export const BROAD: FocusKey = 'broad';

/**
 * "a, b and c". Two phrases where one has its own "and" get a comma ("weak login and session handling, and injection
 * flaws"), so the two areas never run together.
 */
const list = (items: readonly string[]): string =>
  items.length === 2 && items.some((i) => i.includes(' and '))
    ? `${items[0] ?? ''}, and ${items[1] ?? ''}`
    : new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' }).format(items);

/** "Look for {phrases}. {free text}" (spec §3.3). Nothing picked means the broad sweep. */
export function composeObjective(keys: readonly FocusKey[], text: string): string {
  const picked = FOCUS_CHIPS.filter((c) => keys.includes(c.key));
  const phrases = (picked.length === 0 ? FOCUS_CHIPS.filter((c) => c.key === BROAD) : picked).map((c) => c.phrase);
  const extra = text.trim();
  return `Look for ${list(phrases)}.${extra === '' ? '' : ` ${extra}`}`;
}

/** The chips and free text back from an objective composed above (anything else is free text). */
export function readObjective(objective: string): { keys: FocusKey[]; text: string } {
  const m = /^Look for (.+?)\.(?:\s+([\s\S]*))?$/.exec(objective.trim());
  if (m === null) return { keys: [], text: objective.trim() };
  const head = m[1] ?? '';
  const keys = FOCUS_CHIPS.filter((c) => head.includes(c.phrase)).map((c) => c.key);
  return keys.length === 0 ? { keys: [], text: objective.trim() } : { keys, text: (m[2] ?? '').trim() };
}

/** Picking a chip: a specific one drops the broad sweep; clearing them all brings it back. */
export function toggleFocus(keys: readonly FocusKey[], key: FocusKey, on: boolean): FocusKey[] {
  if (key === BROAD) return on ? [BROAD] : keys.filter((k) => k !== BROAD);
  const next = on ? [...keys.filter((k) => k !== BROAD && k !== key), key] : keys.filter((k) => k !== key);
  return next.length === 0 ? [BROAD] : next;
}

const STAGING = /(^|[.-])(staging|stage|dev|test|qa|uat|lab|local)([.-]|$)/i;
const PRIVATE_HOST =
  /^(localhost|[^.]+\.local|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|\[::1\])(:\d+)?$/i;

export type Care = 'passive' | 'active_safe';

/** A loopback or private-network host ("localhost:3001", "10.0.0.5"): it can't be checked from outside. */
export const isPrivateHost = (host: string): boolean => PRIVATE_HOST.test(host);

const FORBIDDEN_HOST = /^(169\.254(\.\d{1,3}){2}|metadata\.google\.internal|\[?fd00:ec2::254\]?)(:\d+)?$/i;
/** Cloud metadata and link-local addresses: never testable, so never offered a way to verify. */
export const isForbiddenHost = (host: string): boolean => FORBIDDEN_HOST.test(host);
export const FORBIDDEN_MESSAGE = 'Cloud metadata and link-local addresses can never be tested.';

/** A private or local address the operator has not listed as a lab: no proof can ever succeed for it. */
export const unverifiableHost = (host: string, asset: Pick<Asset, 'verification'>): boolean =>
  isPrivateHost(host) && !attestationAllowed(asset);

/** Q4's recommendation from the host: gentle probing suits staging, local and lab hosts; a live site gets look-only. */
export const recommendedCare = (host: string): Care =>
  isPrivateHost(host) || STAGING.test(host.replace(/:\d+$/, '')) ? 'active_safe' : 'passive';

/** The owner's word is accepted only where the API says so (an address the operator listed as a lab). */
export const attestationAllowed = (a: Pick<Asset, 'verification'> | null): boolean =>
  a?.verification?.methods.includes('owner_attestation') ?? true;

/** Q2's recommendation: a file for a public site, the owner's word for a private one (a lab app may not serve files,
 * and the check comes from Blackwing's server, which may not reach it), but never a way the API does not accept. */
export const recommendedProof = (host: string, asset: Pick<Asset, 'verification'> | null = null): 'file' | 'attest' =>
  isPrivateHost(host) && attestationAllowed(asset) ? 'attest' : 'file';

/** "Recommended" and the Q4 hints: a white pill with a gold ring, legible on a selected (gold-soft) card too. */
export const RECOMMEND_PILL =
  'inline-flex h-5 items-center rounded-md bg-card px-2 text-[11px] font-semibold text-gold-ink shadow-[inset_0_0_0_1px_var(--gold-line)]';

export const CARE = {
  passive: { label: "Look, don't touch", line: 'Reads only: GET, HEAD and OPTIONS.', badge: 'Suits a live site' },
  active_safe: {
    label: 'Probe gently',
    line: 'Crafted read requests that should not change data.',
    badge: 'Suits a staging or local site',
  },
} as const;

/** "6 Nov 2026" in the reader's locale. */
export const dayLabel = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

export const isVerified = (a: Pick<Asset, 'ownership'>): boolean => a.ownership.status === 'verified';

/**
 * A plan someone said yes to at Gate 1. The run moves the request on ('running', then 'completed', 'failed' or
 * 'killed'), so anything past pending that is not a refusal was approved.
 */
export const wasApproved = (status: string): boolean => status !== 'pending_gate1' && status !== 'rejected';

/** The run of this approval stopped or failed: the approval is used up, and only a new plan can run again. */
export const approvalEnded = (status: string): boolean => status === 'failed' || status === 'killed';

/** The site's origin from what the API stored. */
export const originOf = (a: Pick<Asset, 'baseUrl'>): string => {
  try {
    return new URL(a.baseUrl).origin;
  } catch {
    return a.baseUrl;
  }
};

const MORNING_UNTIL = 12;
const AFTERNOON_UNTIL = 18;

/** Home's greeting by the hour (the reader's own clock on the client). */
export const greetingFor = (hour: number): string =>
  hour < MORNING_UNTIL ? 'Good morning' : hour < AFTERNOON_UNTIL ? 'Good afternoon' : 'Good evening';
