// Unfinished orders, kept on this device (experience spec §10.5). The order (/audits/new) writes them; the sidebar's
// "Drafts" group lists them. Browser storage can be missing or throw (private windows): every access is guarded.
// shortcut: drafts are per device (localStorage). Upgrade to a server draft when teams need hand-off.
import { z } from 'zod';

const DRAFTS_KEY = 'bw:drafts';
/** Fired on `window` whenever the drafts change, so the sidebar updates in the same tab. */
export const DRAFTS_EVENT = 'bw:drafts';
const MAX_DRAFTS = 5;
const QUESTIONS = 4;

export const draftSchema = z.object({
  /** Stable id of the draft (the order picks it, e.g. crypto.randomUUID()). */
  id: z.string().min(1),
  /** The normalised origin being ordered. */
  origin: z.string(),
  host: z.string(),
  /** The question the person was on (1 to 4). */
  step: z.number().int().min(1).max(QUESTIONS),
  /** The order's own answers, opaque here. */
  answers: z.record(z.string(), z.unknown()).default({}),
  savedAt: z.string(),
});
export type Draft = z.infer<typeof draftSchema>;

export function readDrafts(): Draft[] {
  try {
    const parsed = z.array(draftSchema).safeParse(JSON.parse(window.localStorage.getItem(DRAFTS_KEY) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function write(drafts: readonly Draft[]): void {
  try {
    window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts.slice(0, MAX_DRAFTS)));
    window.dispatchEvent(new Event(DRAFTS_EVENT));
  } catch {
    // Storage unavailable: the draft lives only in the page.
  }
}

/** Saves (or replaces) a draft, newest first. */
export function saveDraft(draft: Draft): void {
  write([draft, ...readDrafts().filter((d) => d.id !== draft.id)]);
}

export function removeDraft(id: string): void {
  write(readDrafts().filter((d) => d.id !== id));
}

/** Where a draft's sidebar row leads. */
export const draftHref = (d: Draft): string =>
  `/audits/new?draft=${encodeURIComponent(d.id)}&target=${encodeURIComponent(d.origin)}&step=${d.step}`;
