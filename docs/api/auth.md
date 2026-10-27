# Authentication

The `/v1` API accepts two kinds of credential. Both are checked on every request. Neither can name a tenant in the body
or the query: the tenant comes from the verified credential only.

| Credential | Used by | How it is sent |
|---|---|---|
| Session cookie `__Host-bw_session` | The web console, through its backend-for-frontend (BFF). | The browser sends the cookie. Scripts do not use it. |
| Personal access token `bw_pat_…` | A person who calls the API from a script or a terminal. | `Authorization: Bearer bw_pat_<token>` |
| CI token `bw_ci_…` | An automated pipeline. | `Authorization: Bearer bw_ci_<token>` |

In the examples below, `<token>` stands for a value you have been issued. It is not a real value.

## Getting a token

Tokens are issued for one tenant. The step-by-step guide to issuing them is part of the console documentation, which is not
published in this reference yet; ask your tenant administrator if you cannot issue one. Each token has:

- a set of scopes. An operation that needs a specific scope names it in its description, for example `kill:trigger` for the
  kill-switch trigger;
- an optional binding to assets (`asset_ids`) or to a standing authorisation. A bound token can act only inside that
  binding;
- an expiry (`expires_at`), an optional revocation (`revoked_at`) and a `last_used_at` record.

Give each token the narrowest scopes and binding that its job needs. Use a CI token for pipelines, not a personal token.

## Calling the API

```sh
curl -sS https://<your-tenant-host>/v1/kill/<killEventId> \
  -H "Authorization: Bearer bw_pat_<token>"
```

A request with no credential, an expired one, a revoked one or one that is not valid for the tenant answers
`401 UNAUTHENTICATED`. A valid credential without the scope or the binding for the operation answers `403`.

## Handling tokens safely

- Store tokens in your secret manager or CI secret store. Never put one in source code, a commit, a ticket, a chat or a
  log line.
- Send tokens only over HTTPS, and only to the platform's own host.
- Revoke a token at once when you suspect it has leaked, and create a new one.
- The platform stores only a SHA-256 hash of each token and looks it up by its prefix. It cannot recover a lost token.
  Create a new one instead.
- Rotate CI tokens on a schedule, and when the people or pipelines that held them change.

## Scopes and tenant isolation

Scopes say what a token may ask for. They do not replace the resource checks. A token with the right scope still cannot
act on an asset outside its binding, or on another tenant's data. Those attempts are refused and recorded in the audit
trail.

If a request fails with `403`, read the `code` in the response. `FORBIDDEN` means the scope or the RBAC role is
missing. `KILL_FORBIDDEN` and similar codes name the specific check that refused the action.
