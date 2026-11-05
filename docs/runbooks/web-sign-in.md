---
last_validated: 2026-11-05
---

# Runbook: console sign-in (Google)

Code: `apps/web/src/lib/auth.ts`, `apps/web/src/lib/auth-actions.ts`, `apps/web/src/middleware.ts`, the Auth.js
route `apps/web/src/app/api/auth/[...nextauth]/route.ts` and the page `apps/web/src/app/login/`.

The console signs in with Google through Auth.js (`next-auth` 5). The session is a JWT encrypted with
`AUTH_SECRET` in the httpOnly cookie `authjs.session-token` (`__Secure-authjs.session-token` over HTTPS). There is
no database adapter and no session service, so a page never waits on one.

## Who gets in

- Only a Google account with a verified e-mail listed in `BW_ADMIN_EMAILS` (comma separated, case-insensitive).
  Anyone else is sent back to `/login`, which shows **No access** and a button to choose another account.
- The list is checked again on every request: removing an e-mail locks that person out at once.
- Every administrator holds every role (`appsec-engineer`, `asset-owner`, `developer`, `org-admin`, `auditor`) and
  may approve its own Gate 1 and Gate 2 requests; the audit ledger marks those decisions as self-approved.

## Flow

| Step | Where |
|---|---|
| A signed-out visit to a console page | `middleware.ts` redirects to `/login?callbackUrl=…` |
| **Continue with Google** | Server Action `signInWithGoogle` → `https://accounts.google.com/…` with `redirect_uri=<AUTH_URL>/api/auth/callback/google` |
| Google returns | `/api/auth/callback/google`; the `signIn` callback admits only listed, verified e-mails |
| Each page and API route | `getViewer()` decrypts the cookie and re-checks the e-mail; the identity goes to the API over the internal hop (`x-bw-demo-*` headers plus `BW_DEMO_INTERNAL_TOKEN`) |
| **Sign out** | Server Action `signOutAction` clears the cookie and returns to `/login` |

The Google client must allow the redirect URI `http://localhost:3100/api/auth/callback/google` (and the hosted
origin's equivalent).

## Validation

```sh
curl -s http://localhost:3100/api/auth/providers   # lists "google" with callbackUrl …/api/auth/callback/google
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost:3100/   # 307 to /login
```

Then sign in with an administrator account in a browser and with another Google account (expect **No access**).
