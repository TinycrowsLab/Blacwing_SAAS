// The one shape the operator BFF returns about a session (#838): the operator's id and roles, the CSRF token for
// mutations and the access token's expiry. Built field by field, so no token can leak through a spread.

import type { OperatorSessionRecord } from './session-store.js';

export interface OperatorSessionView {
  readonly operator: { readonly id: string; readonly email: string; readonly name: string };
  readonly roles: readonly string[];
  readonly csrfToken: string;
  /** ISO-8601 UTC instant at which the access token expires. */
  readonly expiresAt: string;
}

export function operatorSessionView(record: OperatorSessionRecord): OperatorSessionView {
  return {
    operator: { id: record.sub, email: record.email, name: record.name },
    roles: [...record.roles],
    csrfToken: record.csrf,
    expiresAt: new Date(record.accessExpiresAt).toISOString(),
  };
}
