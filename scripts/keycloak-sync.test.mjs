import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  flowKeys,
  loadRealm,
  main,
  OPERATOR_REALM_FILE,
  REQUIRED_OPERATOR_CLIENTS,
  resolvePlaceholders,
  sync,
  validateOperatorRealm,
  validateRealm,
} from './keycloak-sync.mjs';

const ENV = {
  BW_ENVIRONMENT: 'prod',
  BW_KEYCLOAK_PUBLIC_URL: 'https://id.example.test',
  BW_CONSOLE_ORIGIN: 'https://app.example.test',
  BW_KEYCLOAK_API_SECRET: 'a',
  BW_KEYCLOAK_CLI_SECRET: 'b',
};

/**
 * @param {ReturnType<typeof loadRealm>} realm
 * @param {number} i
 */
function clientAt(realm, i) {
  const c = realm.clients?.[i];
  assert.ok(c, `realm has client #${i}`);
  return c;
}

test('committed realm is valid and has no literal secrets', () => {
  const r = loadRealm();
  assert.deepEqual(validateRealm(r), []);
  assert.doesNotMatch(JSON.stringify(r), /"secret":\s*"(?!\$\{)/);
});

test('validation rejects weakened settings', () => {
  const r = loadRealm();
  r.bruteForceProtected = false;
  const [console_, api] = [clientAt(r, 0), clientAt(r, 1)];
  console_.attributes = {};
  console_.redirectUris = ['https://x.test/*'];
  api.secret = 'literal';
  const p = validateRealm(r).join('\n');
  assert.match(p, /bruteForceProtected/);
  assert.match(p, /PKCE S256/);
  assert.match(p, /wildcard/);
  assert.match(p, /literal secret/);
});

test('placeholders resolve; missing ones fail closed', () => {
  const out = resolvePlaceholders(loadRealm(), ENV);
  assert.equal(JSON.stringify(out).includes('${'), false);
  assert.throws(() => resolvePlaceholders(loadRealm(), {}), /BW_CONSOLE_ORIGIN/);
});

/** @typedef {Record<string, unknown>} Doc */

function fakeKeycloak() {
  /**
   * `flows` maps a flow alias to its direct child rows; a sub-flow row names its flow in `flowAlias`.
   * @type {{ realm: Doc | null, roles: Map<string, Doc>, scopes: Doc[], clients: Doc[], calls: string[],
   *   flows: Map<string, Doc[]>, flowList: Doc[], requiredActions: Map<string, Doc> }}
   */
  const db = {
    realm: null,
    roles: new Map(),
    scopes: [],
    clients: [],
    calls: [],
    flows: new Map(),
    flowList: [],
    requiredActions: new Map(),
  };
  /** The flat listing the Admin API returns for a flow: depth-first, `level` relative to the queried flow. */
  /** @type {(alias: string, level?: number) => Doc[]} */
  const listing = (alias, level = 0) =>
    (db.flows.get(alias) ?? []).flatMap((row) => [
      { ...row, level },
      ...(row.authenticationFlow === true ? listing(String(row.flowAlias), level + 1) : []),
    ]);
  /** The Admin API paths under /authentication, handled before the realm-level routes. */
  /** @type {(method: string | undefined, rest: string, b: Doc) => Response} */
  const authentication = (method, rest, b) => {
    const j2 = (/** @type {unknown} */ x, /** @type {number} */ s = 200) =>
      /** @type {Response} */ (
        /** @type {unknown} */ ({ ok: s < 300, status: s, json: () => Promise.resolve(x) })
      );
    if (rest.startsWith('/required-actions/') && method === 'PUT') {
      db.requiredActions.set(decodeURIComponent(rest.slice('/required-actions/'.length)), b);
      return j2(null, 204);
    }
    if (rest === '/flows') {
      if (method === 'GET') return j2(db.flowList);
      db.flowList.push({ id: `f${++n}`, alias: b.alias });
      db.flows.set(String(b.alias), []);
      return j2(null, 201);
    }
    const m = /^\/flows\/([^/]+)\/executions(\/execution|\/flow)?$/.exec(rest);
    if (!m) return j2({}, 404);
    const alias = decodeURIComponent(String(m[1]));
    const rows = db.flows.get(alias);
    if (!rows) return j2({}, 404);
    if (m[2] === undefined) {
      if (method === 'GET') return j2(listing(alias));
      const row = rows.find((r) => r.id === b.id);
      if (!row) return j2({}, 404);
      row.requirement = b.requirement;
      return j2(null, 204);
    }
    if (m[2] === '/execution') {
      rows.push({
        id: `e${++n}`,
        providerId: b.provider,
        authenticationFlow: false,
        requirement: 'DISABLED',
      });
      return j2(null, 201);
    }
    rows.push({
      id: `e${++n}`,
      displayName: b.alias,
      authenticationFlow: true,
      flowAlias: b.alias,
      requirement: 'DISABLED',
    });
    db.flows.set(String(b.alias), []);
    db.flowList.push({ id: `f${n}`, alias: b.alias });
    return j2(null, 201);
  };
  let n = 0;
  /** @type {(b: unknown, s?: number) => Response} */
  const j = (b, s = 200) =>
    /** @type {Response} */ (
      /** @type {unknown} */ ({ ok: s < 300, status: s, json: () => Promise.resolve(b) })
    );
  /** @type {typeof fetch} */
  const fetchFn = (url, { method, body } = {}) => {
    const parsed = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    const u = parsed.pathname;
    /** @type {Doc} */
    const b = typeof body === 'string' ? /** @type {Doc} */ (JSON.parse(body)) : {};
    db.calls.push(`${method} ${u}`);
    return Promise.resolve(handle(method, u, parsed, b));
  };
  /** @type {(method: string | undefined, u: string, parsed: URL, b: Doc) => Response} */
  const handle = (method, u, parsed, b) => {
    // Any realm: the tenant and the platform-operator realm are both served (#838).
    const authPrefix = /^\/admin\/realms\/[^/]+\/authentication/.exec(u)?.[0];
    if (authPrefix !== undefined) return authentication(method, u.slice(authPrefix.length), b);
    if (/^\/admin\/realms\/[^/]+$/.test(u)) {
      if (method === 'GET') return db.realm ? j(db.realm) : j({}, 404);
      db.realm = db.realm ? { ...db.realm, ...b } : b;
      return j(null, 204);
    }
    if (u === '/admin/realms') {
      db.realm = b;
      return j(null, 201);
    }
    if (u.includes('/roles')) {
      const nm = decodeURIComponent((u.split('/roles')[1] ?? '').replace(/^\//, ''));
      if (method === 'GET') return db.roles.has(nm) ? j({ name: nm }) : j({}, 404);
      if (method === 'POST') db.roles.set(String(b.name), b);
      return j(null, 204);
    }
    if (u.includes('/client-scopes')) {
      if (method === 'GET') return j(db.scopes);
      if (method === 'POST') db.scopes.push({ ...b, id: `s${++n}` });
      return j(null, 204);
    }
    if (u.includes('/clients')) {
      if (method === 'GET') {
        const q = parsed.searchParams.get('clientId');
        return j(q ? db.clients.filter((c) => c.clientId === q) : db.clients);
      }
      if (method === 'POST') db.clients.push({ ...b, id: `c${++n}` });
      return j(null, 204);
    }
    throw new Error(`unexpected ${method} ${u}`);
  };
  return { db, fetchFn };
}

test('sync is idempotent: re-run creates nothing, never deletes or touches users', async () => {
  const realm = resolvePlaceholders(loadRealm(), ENV);
  const { db, fetchFn } = fakeKeycloak();
  const first = await sync(realm, { base: 'http://kc', token: 't', fetchFn });
  assert.ok(first.created > 0);
  const counts = [db.clients.length, db.roles.size, db.scopes.length];
  const second = await sync(realm, { base: 'http://kc', token: 't', fetchFn });
  assert.equal(second.created, 0);
  assert.deepEqual([db.clients.length, db.roles.size, db.scopes.length], counts);
  assert.equal(db.clients.length, 3);
  assert.ok(!db.calls.some((c) => c.startsWith('DELETE') || c.includes('/users')));
});

test('post-sync assertion fails when a required client is missing', async () => {
  const realm = resolvePlaceholders(loadRealm(), ENV);
  realm.clients = (realm.clients ?? []).filter((c) => c.clientId !== 'blackwing-cli');
  const { fetchFn } = fakeKeycloak();
  await assert.rejects(sync(realm, { base: 'http://kc', token: 't', fetchFn }), /blackwing-cli/);
});

test('validation rejects weakened MFA settings', () => {
  const r = loadRealm();
  r.otpPolicyLookAheadWindow = 5;
  r.otpPolicyCodeReusable = true;
  r.webAuthnPolicyUserVerificationRequirement = 'preferred';
  r.attributes = { ...r.attributes, 'acr.loa.map': '{"password":1,"mfa":2}' };
  r.browserFlow = 'browser';
  const mfa = r.mfa;
  assert.ok(mfa?.flow && mfa.requiredActions);
  // Drop the OTP factor and keep only the password step under the forms sub-flow.
  mfa.flow.executions = [
    { provider: 'auth-cookie', requirement: 'ALTERNATIVE' },
    {
      alias: 'blackwing forms',
      requirement: 'ALTERNATIVE',
      children: [
        { provider: 'auth-username-password-form', requirement: 'REQUIRED' },
        {
          alias: 'blackwing conditional WebAuthn',
          requirement: 'CONDITIONAL',
          children: [
            { provider: 'conditional-user-configured', requirement: 'REQUIRED' },
            { provider: 'webauthn-authenticator', requirement: 'REQUIRED' },
          ],
        },
      ],
    },
  ];
  const ra = mfa.requiredActions.find((a) => a.alias === 'CONFIGURE_TOTP');
  assert.ok(ra);
  ra.enabled = false;
  const p = validateRealm(r).join('\n');
  assert.match(p, /LookAheadWindow/);
  assert.match(p, /otpPolicyCodeReusable/);
  assert.match(p, /user verification/);
  assert.match(p, /acr\.loa\.map must map exactly/);
  assert.match(p, /browserFlow must be the mfa flow alias/);
  assert.match(p, /mfa flow missing auth-otp-form/);
  assert.match(p, /required action CONFIGURE_TOTP must be enabled/);
});

test('flow listing keys follow the depth-first order the Admin API returns', () => {
  const mfa = loadRealm().mfa;
  assert.ok(mfa?.flow);
  assert.deepEqual(flowKeys(mfa.flow.executions), [
    '0|exec:auth-cookie|ALTERNATIVE',
    '0|exec:identity-provider-redirector|ALTERNATIVE',
    '0|flow:blackwing forms|ALTERNATIVE',
    '1|exec:auth-username-password-form|REQUIRED',
    '1|flow:blackwing conditional OTP|CONDITIONAL',
    '2|exec:conditional-user-configured|REQUIRED',
    '2|exec:auth-otp-form|REQUIRED',
    '1|flow:blackwing conditional WebAuthn|CONDITIONAL',
    '2|exec:conditional-user-configured|REQUIRED',
    '2|exec:webauthn-authenticator|REQUIRED',
  ]);
});

test('sync creates the MFA browser flow, enables the factors and binds the flow', async () => {
  const realm = resolvePlaceholders(loadRealm(), ENV);
  const mfa = realm.mfa;
  assert.ok(mfa?.flow);
  const { db, fetchFn } = fakeKeycloak();
  await sync(realm, { base: 'http://kc', token: 't', fetchFn });
  assert.ok(db.realm);
  assert.equal(db.realm.browserFlow, 'blackwing browser');
  assert.equal(db.realm.mfa, undefined);
  assert.equal(db.requiredActions.get('CONFIGURE_TOTP')?.enabled, true);
  assert.equal(db.requiredActions.get('webauthn-register')?.enabled, true);
  assert.equal(db.flowList.length, 4);
  assert.equal(
    db.calls.filter((c) => c.endsWith('/executions/execution')).length,
    flowKeys(mfa.flow.executions).filter((k) => k.includes('|exec:')).length,
  );
});

test('re-running sync creates nothing and leaves the flow untouched', async () => {
  const realm = resolvePlaceholders(loadRealm(), ENV);
  const { db, fetchFn } = fakeKeycloak();
  await sync(realm, { base: 'http://kc', token: 't', fetchFn });
  const before = db.calls.length;
  const second = await sync(realm, { base: 'http://kc', token: 't', fetchFn });
  assert.equal(second.created, 0);
  assert.equal(db.flowList.length, 4);
  assert.equal(db.calls.slice(before).filter((c) => c.startsWith('POST')).length, 0);
});

test('a drifted live flow fails the sync without writing to it', async () => {
  const realm = resolvePlaceholders(loadRealm(), ENV);
  const { db, fetchFn } = fakeKeycloak();
  await sync(realm, { base: 'http://kc', token: 't', fetchFn });
  const forms = db.flows.get('blackwing forms') ?? [];
  const row = forms.find((r) => r.displayName === 'blackwing conditional OTP');
  assert.ok(row);
  row.requirement = 'DISABLED';
  const before = db.calls.length;
  await assert.rejects(
    sync(realm, { base: 'http://kc', token: 't', fetchFn }),
    /differs from realm-blackwing\.json/,
  );
  assert.ok(
    !db.calls.slice(before).some((c) => /^(POST|PUT|DELETE) .*\/authentication\/flows/.test(c)),
  );
});

/** The committed platform-operator realm with the placeholder values it needs (#838). */
const OPERATOR_ENV = {
  BW_ENVIRONMENT: 'prod',
  BW_KEYCLOAK_PUBLIC_URL: 'https://id.example.test',
  BW_CONSOLE_ORIGIN: 'https://app.example.test',
  BW_KEYCLOAK_OPERATOR_BFF_SECRET: 'c',
  BW_KEYCLOAK_OPERATOR_API_SECRET: 'd',
};

/** @param {ReturnType<typeof loadRealm>} realm @param {string} clientId */
function operatorClient(realm, clientId) {
  const c = (realm.clients ?? []).find((x) => x.clientId === clientId);
  assert.ok(c, `operator realm has client ${clientId}`);
  return c;
}

test('committed operator realm is valid, separate from the tenant realm and has no users', () => {
  const r = loadRealm(OPERATOR_REALM_FILE);
  assert.deepEqual(validateOperatorRealm(r), []);
  assert.equal(r.realm, 'blackwing-operators');
  assert.equal(r.users, undefined);
  assert.deepEqual(r.identityProviders, []);
  assert.equal(r.registrationAllowed, false);
  assert.doesNotMatch(JSON.stringify(r), /"secret":\s*"(?!\$\{)/);
  const mappers = /** @type {{ config?: Record<string, unknown> }[]} */ (
    (r.clientScopes ?? []).flatMap((x) => x.protocolMappers ?? [])
  );
  assert.equal(
    mappers.some((m) => m.config?.['claim.name'] === 'tenantId'),
    false,
  );
});

test('operator realm validation rejects a weakened tenant-separation or MFA design', () => {
  const r = loadRealm(OPERATOR_REALM_FILE);
  r.identityProviders = [{ alias: 'entra' }];
  r.registrationAllowed = true;
  r.clientScopes?.[0]?.protocolMappers?.push({
    name: 'tenantId',
    config: { 'claim.name': 'tenantId' },
  });
  const p = validateOperatorRealm(r).join('\n');
  assert.match(p, /identity providers/);
  assert.match(p, /registrationAllowed/);
  assert.match(p, /tenantId claim/);
});

test('operator realm validation rejects a conditional second factor and a non-forced enrolment', () => {
  const r = loadRealm(OPERATOR_REALM_FILE);
  // The second factor sub-flow of the operator browser flow: the forms step's second child.
  const forms = /** @type {{ children: unknown[] }} */ (
    /** @type {unknown} */ (r.mfa?.flow?.executions[1])
  );
  const second =
    /** @type {{ requirement: string, children: { provider: string, requirement: string }[] }} */ (
      /** @type {unknown} */ (forms.children[1])
    );
  assert.ok(second);
  second.requirement = 'CONDITIONAL';
  second.children.push({ provider: 'conditional-user-configured', requirement: 'REQUIRED' });
  const configure = r.mfa?.requiredActions?.find((a) => a.alias === 'CONFIGURE_TOTP');
  assert.ok(configure);
  configure.defaultAction = false;
  const p = validateOperatorRealm(r).join('\n');
  assert.match(p, /must not be conditional/);
  assert.match(p, /forced enrolment/);
});

test('operator realm validation rejects public, implicit and literal-secret clients and a wrong acr', () => {
  const r = loadRealm(OPERATOR_REALM_FILE);
  const bff = operatorClient(r, 'operator-bff');
  bff.publicClient = true;
  bff.implicitFlowEnabled = true;
  bff.secret = 'literal';
  r.attributes = { ...r.attributes, 'acr.loa.map': '{"password":1,"strong":2}' };
  r.roles = { realm: [{ name: 'platform_operator' }] };
  const p = validateOperatorRealm(r).join('\n');
  assert.match(p, /confidential/);
  assert.match(p, /implicit, password/);
  assert.match(p, /literal secret/);
  assert.match(p, /operator_strong=2/);
  assert.match(p, /missing role platform_admin/);
});

test('operator sync creates the operator realm and asserts its own clients', async () => {
  const realm = resolvePlaceholders(loadRealm(OPERATOR_REALM_FILE), OPERATOR_ENV);
  const { db, fetchFn } = fakeKeycloak();
  const stats = await sync(realm, {
    base: 'http://kc',
    token: 't',
    fetchFn,
    requiredClients: REQUIRED_OPERATOR_CLIENTS,
  });
  assert.ok(stats.created > 0);
  assert.equal(db.clients.length, 2);
  assert.equal(db.realm?.browserFlow, 'blackwing operator browser');
  assert.equal(db.requiredActions.get('CONFIGURE_TOTP')?.defaultAction, true);
  assert.ok(db.calls.some((c) => c.includes('/admin/realms/blackwing-operators')));
  assert.ok(!db.calls.some((c) => c.includes('/users')));
});

test('operator sync fails the post-sync assertion when operator-api is missing', async () => {
  const realm = resolvePlaceholders(loadRealm(OPERATOR_REALM_FILE), OPERATOR_ENV);
  realm.clients = (realm.clients ?? []).filter((c) => c.clientId !== 'operator-api');
  const { fetchFn } = fakeKeycloak();
  await assert.rejects(
    sync(realm, {
      base: 'http://kc',
      token: 't',
      fetchFn,
      requiredClients: REQUIRED_OPERATOR_CLIENTS,
    }),
    /operator-api/,
  );
});

test('operator placeholders fail closed when an operator secret is missing', () => {
  assert.throws(
    () =>
      resolvePlaceholders(loadRealm(OPERATOR_REALM_FILE), {
        ...OPERATOR_ENV,
        BW_KEYCLOAK_OPERATOR_BFF_SECRET: '',
      }),
    /BW_KEYCLOAK_OPERATOR_BFF_SECRET/,
  );
});

test('check validates both committed realms offline and apply refuses to run without admin credentials', async () => {
  /** @type {string[]} */
  const written = [];
  /** @type {(m: string) => boolean} */
  const capture = (m) => {
    written.push(m);
    return true;
  };
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    /** @type {unknown} */ (capture)
  );
  process.stderr.write = /** @type {typeof process.stderr.write} */ (
    /** @type {unknown} */ (capture)
  );
  try {
    assert.equal(await main(['check'], {}), 0);
    assert.equal(await main(['apply'], {}), 1);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.ok(written.includes('realm-blackwing-operators.json: ok\n'));
  assert.ok(written.includes('realm-blackwing.json: ok\n'));
  assert.ok(written.some((m) => m.includes('missing environment variable BW_KEYCLOAK_URL')));
});
