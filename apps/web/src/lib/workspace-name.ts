// The workspace name proposed on /welcome, from the signed-in Google account (experience spec §3.1). Pure.

/** Consumer mail domains: nobody's company name. */
const CONSUMER_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
]);

// shortcut: a two-part public suffix is recognised by shape (co.uk, com.au, ac.in...), not the full Public Suffix List;
// upgrade to the PSL if a customer's domain is named wrongly.
const SECOND_LEVEL = /^(co|com|ac|edu|gov|org|net|ltd|plc)\.[a-z]{2}$/;
/** Labels a two-part suffix needs before the registrable one is found (`x.example.co.uk`). */
const MIN_LABELS_FOR_TWO_PART = 3;

export const WORKSPACE_NAME_MIN = 2;
export const WORKSPACE_NAME_MAX = 60;

const titleCase = (label: string): string =>
  label
    .split(/[-_]+/)
    .filter((p) => p !== '')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');

/** The registrable label of a domain: `mail.tinycrows.co.uk` gives `tinycrows`. */
export function registrableLabel(domain: string): string {
  const labels = domain
    .toLowerCase()
    .split('.')
    .filter((l) => l !== '');
  const twoPart =
    labels.length >= MIN_LABELS_FOR_TWO_PART &&
    SECOND_LEVEL.test(labels.slice(1 - MIN_LABELS_FOR_TWO_PART).join('.'));
  // The label before the suffix: second to last, or third to last under a two-part suffix.
  return (
    labels.at(twoPart ? -MIN_LABELS_FOR_TWO_PART : 1 - MIN_LABELS_FOR_TWO_PART) ?? labels[0] ?? ''
  );
}

export interface ProposedName {
  readonly name: string;
  /** The domain the name came from; null for a consumer address. */
  readonly domain: string | null;
}

/** From the `hd` claim, else the e-mail domain; a consumer domain proposes "{Given name}'s workspace". */
export function proposeWorkspaceName(input: {
  readonly email: string;
  readonly hd?: string | null | undefined;
  readonly givenName?: string | null | undefined;
}): ProposedName {
  const domain = (input.hd ?? input.email.split('@')[1] ?? '').trim().toLowerCase();
  if (domain !== '' && !CONSUMER_DOMAINS.has(domain)) {
    const name = titleCase(registrableLabel(domain));
    if (name.length >= WORKSPACE_NAME_MIN)
      return { name: name.slice(0, WORKSPACE_NAME_MAX), domain };
  }
  const fromClaim = input.givenName?.trim() ?? '';
  const fromEmail = titleCase(input.email.split('@')[0] ?? '');
  const given = fromClaim !== '' ? fromClaim : fromEmail !== '' ? fromEmail : 'My';
  return { name: `${given}'s workspace`.slice(0, WORKSPACE_NAME_MAX), domain: null };
}

/** "  Tinycrows   Security " is stored as "Tinycrows Security". */
export const tidyWorkspaceName = (name: string): string => name.trim().replace(/\s+/g, ' ');

/**
 * Null when the name is fine; otherwise the message to show under the field. Checked on the tidied name and counted
 * in code points, as the API counts: "😀" is one character, so it is too short here instead of failing on the server.
 */
export function workspaceNameError(name: string): string | null {
  const length = Array.from(tidyWorkspaceName(name)).length;
  if (length < WORKSPACE_NAME_MIN) return 'A name needs at least 2 characters.';
  if (length > WORKSPACE_NAME_MAX) return 'Keep it under 60 characters.';
  return null;
}
