// Demo only: a named presenter login (BW_DEMO_LOGIN_EMAIL / BW_DEMO_LOGIN_PASSWORD from the gitignored
// .env.demo) in the Keycloak dev realm, with the AppSec engineer and asset owner groups. `node scripts/demo.mjs up`
// calls syncDemoLogin and then adds the matching user and membership to the demo database.
// Nothing here prints the password or a token.

import { REALM } from './keycloak-google-idp.mjs';

export const DEMO_LOGIN_GROUPS = Object.freeze(['/acme/appsec-engineers', '/acme/asset-owners']);
/** `memberships.roles[]` for the same login (the API reads roles from the token; this keeps the directory honest). */
export const DEMO_LOGIN_ROLES = Object.freeze(['appsec_engineer', 'asset_owner']);
const EMAIL = /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Returns the email when both values are set and the email is plain, '' when unset; throws on a bad email.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function demoLoginEmail(env) {
  const email = (env.BW_DEMO_LOGIN_EMAIL ?? '').trim().toLowerCase();
  if (email === '' || (env.BW_DEMO_LOGIN_PASSWORD ?? '') === '') return '';
  if (!EMAIL.test(email)) throw new Error('BW_DEMO_LOGIN_EMAIL is not a plain e-mail address');
  return email;
}

/**
 * Creates or updates the login: enabled, verified e-mail, tenant `acme`, both groups, and the password.
 * @param {{ base: string, adminUser: string, adminPassword: string, email: string, password: string,
 *   name?: string, fetchFn?: typeof fetch }} input
 * @returns {Promise<{ sub: string, created: boolean }>}
 */
export async function syncDemoLogin(input) {
  const fetchFn = input.fetchFn ?? fetch;
  const tokenRes = await fetchFn(`${input.base}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: input.adminUser,
      password: input.adminPassword,
    }),
  });
  if (!tokenRes.ok) throw new Error(`admin sign-in to Keycloak failed: HTTP ${tokenRes.status}`);
  const token = /** @type {{ access_token: string }} */ (await tokenRes.json()).access_token;
  const api = (
    /** @type {string} */ method,
    /** @type {string} */ p,
    /** @type {unknown} */ body,
  ) =>
    fetchFn(`${input.base}/admin/realms/${REALM}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const must = (/** @type {Response} */ res, /** @type {string} */ what) => {
    if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
    return res;
  };

  const [first, ...rest] = (input.name ?? 'Demo Tinycrows').split(' ');
  const rep = {
    username: input.email,
    email: input.email,
    firstName: first,
    lastName: rest.join(' ') || first,
    enabled: true,
    emailVerified: true,
    attributes: { tenant: ['acme'] },
  };
  const find = async () => {
    const res = must(
      await api('GET', `/users?exact=true&username=${encodeURIComponent(input.email)}`),
      'looking up the demo login',
    );
    return /** @type {{ id: string }[]} */ (await res.json())[0]?.id;
  };
  let sub = await find();
  const created = sub === undefined;
  if (created) {
    must(await api('POST', '/users', rep), 'creating the demo login');
    sub = await find();
  } else {
    must(await api('PUT', `/users/${sub}`, rep), 'updating the demo login');
  }
  if (sub === undefined || !UUID.test(sub))
    throw new Error('the demo login has no usable Keycloak id');
  must(
    await api('PUT', `/users/${sub}/reset-password`, {
      type: 'password',
      value: input.password,
      temporary: false,
    }),
    'setting the demo login password',
  );
  for (const groupPath of DEMO_LOGIN_GROUPS) {
    const g = must(await api('GET', `/group-by-path${groupPath}`), `reading group ${groupPath}`);
    const { id } = /** @type {{ id: string }} */ (await g.json());
    must(await api('PUT', `/users/${sub}/groups/${id}`), `joining group ${groupPath}`);
  }
  return { sub, created };
}

/**
 * SQL that upserts the directory user and its `acme` membership. Inputs are validated, so inlining is safe.
 * @param {string} sub
 * @param {string} email
 * @param {string} [name]
 * @returns {string}
 */
export function demoLoginSql(sub, email, name = 'Demo Tinycrows') {
  if (!UUID.test(sub)) throw new Error('bad keycloak id');
  if (!EMAIL.test(email)) throw new Error('bad email');
  if (!/^[A-Za-z .-]+$/.test(name)) throw new Error('bad name');
  const roles = `ARRAY[${DEMO_LOGIN_ROLES.map((r) => `'${r}'`).join(',')}]`;
  // A row that already holds this e-mail (an older Keycloak id) is re-pointed first, so the upsert cannot hit
  // the e-mail unique constraint. psql -c runs both statements in one transaction.
  return `UPDATE users SET keycloak_sub = '${sub}', updated_at = now()
  WHERE email = '${email}' AND keycloak_sub IS DISTINCT FROM '${sub}';
WITH u AS (
  INSERT INTO users (keycloak_sub, email, name) VALUES ('${sub}', '${email}', '${name}')
  ON CONFLICT (keycloak_sub) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, updated_at = now()
  RETURNING id)
INSERT INTO memberships (tenant_id, user_id, roles)
SELECT t.id, u.id, ${roles} FROM u, tenants t WHERE t.slug = 'acme'
ON CONFLICT (tenant_id, user_id) DO UPDATE SET roles = EXCLUDED.roles, updated_at = now()
RETURNING user_id;`;
}
