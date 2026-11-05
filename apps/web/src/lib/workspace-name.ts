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
  const labels = domain.toLowerCase().split('.').filter((l) => l !== '');
  const suffixParts = labels.length >= 3 && SECOND_LEVEL.test(labels.slice(-2).join('.')) ? 2 : 1;
  return labels.at(-(suffixParts + 1)) ?? labels[0] ?? '';
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
    if (name.length >= WORKSPACE_NAME_MIN) return { name: name.slice(0, WORKSPACE_NAME_MAX), domain };
  }
  const given = input.givenName?.trim() || titleCase(input.email.split('@')[0] ?? '') || 'My';
  return { name: `${given}'s workspace`.slice(0, WORKSPACE_NAME_MAX), domain: null };
}

/** Null when the name is fine; otherwise the message to show under the field. Whitespace is trimmed first. */
export function workspaceNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < WORKSPACE_NAME_MIN) return 'A name needs at least 2 characters.';
  if (trimmed.length > WORKSPACE_NAME_MAX) return 'Keep it under 60 characters.';
  return null;
}

/** "Jatin" from "Jatin Singh" when Google gave no given name. */
export const firstName = (fullName: string): string => fullName.trim().split(/\s+/)[0] ?? fullName;
