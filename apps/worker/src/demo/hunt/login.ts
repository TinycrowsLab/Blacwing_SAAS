// Login-form test accounts: the runner (never the model) signs in, keeps the session cookies per role in a jar for
// the run, and signs in again when the session is lost. Pure parsing plus one orchestrating function; all network
// access goes through the `step` callback, which enforces scope, the private-range guard and the request budget.

export interface LoginAccount {
  readonly role: string;
  readonly username: string;
  readonly password: string;
  readonly loginUrl: string | null;
}

/** One role's session for the run. The jar never leaves the runner. */
export interface Session {
  readonly jar: Map<string, string>;
  /** Path of the login page, once known: a redirect to it means the session was lost. */
  loginPath: string | null;
  /** Sign-ins performed so far (the first included). */
  logins: number;
  /** Why the last sign-in failed; null when signed in. */
  failure: string | null;
  /** A sign-in in progress, shared by parallel agents. */
  pending: Promise<boolean> | null;
}

export interface StepRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}
export interface StepResponse {
  readonly status: number;
  readonly location: string | null;
  readonly setCookies: readonly string[];
  readonly body: string;
}
/** Sends one runner request; null when it was refused or failed (scope, budget, address guard, network). */
export type Step = (request: StepRequest) => Promise<StepResponse | null>;

export const MAX_LOGINS = 4;
const MAX_HOPS = 5;
const FALLBACK_PATHS = ['/login', '/login.php', '/signin', '/user/login', '/account/login'];
const LOST_PATH = /(^|\/)(log-?in|sign-?in|auth)(\.\w+)?\/?$/i;

export function newSession(): Session {
  return { jar: new Map(), loginPath: null, logins: 0, failure: null, pending: null };
}

/** Applies Set-Cookie headers to a jar: a value is stored, an empty value or a past expiry removes it. */
export function applySetCookies(jar: Map<string, string>, setCookies: readonly string[]): void {
  for (const line of setCookies) {
    const [pair = '', ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) || attrs.some((a) => /^\s*expires\s*=/i.test(a) && Date.parse(a.slice(a.indexOf('=') + 1)) < Date.now());
    if (value === '' || expired) jar.delete(name);
    else jar.set(name, value);
  }
}

/** The jar as a Cookie header; cookies the model names itself in `own` (a Cookie header) win. */
export function cookieHeader(jar: ReadonlyMap<string, string>, own?: string): string {
  const merged = new Map(jar);
  for (const part of (own ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) merged.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return [...merged].map(([k, v]) => `${k}=${v}`).join('; ');
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m === null ? null : decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
};

function decodeEntities(text: string): string {
  return text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

export interface LoginForm {
  readonly action: string;
  readonly method: string;
  readonly fields: readonly { readonly name: string; readonly value: string }[];
  readonly userField: string;
  readonly passwordField: string;
}

/** The first form with a password input: its action, hidden inputs (CSRF tokens), submit button and credential field names. */
export function findLoginForm(html: string): LoginForm | null {
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const inputs = [...(match[2] ?? '').matchAll(/<input\b[^>]*>/gi)].map((m) => m[0]);
    const typed = inputs.map((tag) => ({ tag, type: (attr(tag, 'type') ?? 'text').toLowerCase(), name: attr(tag, 'name') }));
    const password = typed.find((i) => i.type === 'password' && i.name !== null);
    if (password?.name == null) continue;
    const user = typed.find((i) => i.name !== null && (i.type === 'text' || i.type === 'email') && /user|login|email|name/i.test(i.name)) ?? typed.find((i) => i.name !== null && (i.type === 'text' || i.type === 'email'));
    if (user?.name == null) continue;
    const fields = typed
      .filter((i) => i.name !== null && (i.type === 'hidden' || i.type === 'submit'))
      .map((i) => ({ name: i.name ?? '', value: attr(i.tag, 'value') ?? '' }));
    return { action: attr(match[1] ?? '', 'action') ?? '', method: (attr(match[1] ?? '', 'method') ?? 'get').toUpperCase(), fields, userField: user.name, passwordField: password.name };
  }
  return null;
}

const pathOf = (url: string): string | null => {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
};

/** True when the response sends the browser to the login page (the signal that a session was lost). */
export function redirectsToLogin(res: { status: number; location: string | null }, base: string, loginPath: string | null): boolean {
  if (res.status < 300 || res.status >= 400 || res.location === null) return false;
  let path: string | null;
  try {
    path = new URL(res.location, base).pathname;
  } catch {
    return false;
  }
  return (loginPath !== null && path === loginPath) || LOST_PATH.test(path);
}

/** A plain-language list of the redirect-to-login responses recon saw; used to detect a login wall. */
export function isLoginRedirect(status: number, location: string | null, base: string): boolean {
  return redirectsToLogin({ status, location }, base, null);
}

async function follow(step: Step, jar: Map<string, string>, first: StepRequest): Promise<{ res: StepResponse; url: string } | null> {
  let request = first;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const cookie = cookieHeader(jar);
    const res = await step({ ...request, headers: { ...request.headers, ...(cookie === '' ? {} : { cookie }) } });
    if (res === null) return null;
    applySetCookies(jar, res.setCookies);
    if (res.status >= 300 && res.status < 400 && res.location !== null) {
      request = { method: 'GET', url: new URL(res.location, request.url).href, headers: {} };
      continue;
    }
    return { res, url: request.url };
  }
  return null;
}

/**
 * Signs in: opens the login page (the configured URL, or the site root and the usual login paths), submits the form
 * with its hidden inputs (CSRF tokens) and the credentials, and judges success by the page no longer asking for a
 * password. Fills `session.jar`. Returns null on success or the reason it failed.
 */
export async function performLogin(account: LoginAccount, origin: string, session: Session, step: Step): Promise<string | null> {
  session.jar.clear();
  const starts = account.loginUrl === null ? [origin + '/', ...FALLBACK_PATHS.map((p) => origin + p)] : [account.loginUrl];
  for (const start of starts) {
    const page = await follow(step, session.jar, { method: 'GET', url: start, headers: {} });
    if (page === null) continue;
    const form = findLoginForm(page.res.body);
    if (form === null) continue;
    const action = new URL(form.action === '' ? page.url : form.action, page.url).href;
    const params = new URLSearchParams();
    for (const f of form.fields) params.set(f.name, f.value);
    params.set(form.userField, account.username);
    params.set(form.passwordField, account.password);
    session.loginPath = pathOf(page.url);
    const sent = form.method === 'POST'
      ? await follow(step, session.jar, { method: 'POST', url: action, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() })
      : await follow(step, session.jar, { method: 'GET', url: `${action}${action.includes('?') ? '&' : '?'}${params.toString()}`, headers: {} });
    if (sent === null) return 'The login request was refused or failed.';
    if (sent.res.status >= 400) return `The login form answered with status ${sent.res.status}.`;
    if (findLoginForm(sent.res.body) !== null) return 'The site still shows the login form after submitting the credentials (wrong username or password?).';
    return null;
  }
  return 'No login form was found.';
}
