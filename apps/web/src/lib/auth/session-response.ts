// The one shape the BFF ever returns about a session (IAM-002, #334): public identity, the CSRF token
// the page must echo on mutations, and the access token's expiry. It is built field by field so a
// token can never leak through a spread; it matches `SessionSchema` in `lib/session.ts`.

import type { SessionRecord } from './session-store.js';

export interface SessionView {
  readonly user: { readonly id: string; readonly email: string; readonly name: string };
  readonly tenant: { readonly id: string; readonly slug: string };
  readonly roles: readonly string[];
  readonly csrfToken: string;
  /** ISO-8601 UTC instant at which the access token expires (the page schedules `/refresh` before it). */
  readonly expiresAt: string;
}

export function sessionResponse(record: SessionRecord): SessionView {
  return {
    user: { id: record.sub, email: record.email, name: record.name },
    tenant: { id: record.tenantId, slug: record.tenantSlug },
    roles: [...record.roles],
    csrfToken: record.csrf,
    expiresAt: new Date(record.accessExpiresAt).toISOString(),
  };
}
