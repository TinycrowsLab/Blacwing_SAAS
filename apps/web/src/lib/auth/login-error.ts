// Messages for `/login?error=<reason>` (IAM-002, #334). The reason is an allowlisted code from the
// callback; an unknown value (anyone can craft the URL) shows nothing, so the page never reflects input.

const MESSAGES: Readonly<Record<string, string>> = {
  invalid_state: 'Your sign-in session expired or did not match. Please try again.',
  denied: 'Sign-in was cancelled or refused. Please try again.',
  exchange_failed: 'We could not complete sign-in. Please try again.',
  invalid_token: 'We could not verify your sign-in. Please try again.',
  no_tenant: 'Your account is not linked to an organisation. Contact your administrator.',
  idp_unavailable: 'The sign-in service is unavailable right now. Please try again shortly.',
  store_unavailable: 'Sessions are unavailable right now. Please try again shortly.',
};

/** The user-facing message for a login error code, or `undefined` for anything not on the list. */
export function loginErrorMessage(code: string): string | undefined {
  return Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : undefined;
}
