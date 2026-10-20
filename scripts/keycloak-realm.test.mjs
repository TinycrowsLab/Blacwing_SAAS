import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  BFF_CALLBACK_PATH,
  BFF_CLIENT,
  CI_CLIENT,
  CONSOLE_ORIGINS,
  PASSWORD_PLACEHOLDER,
  PLATFORM_ROLES,
  REALM,
  REALM_FILE,
  TENANT,
  TENANT_ROLES,
  TEST_USERS,
  effectiveRoles,
  loadRealm,
  main,
  parseCliArgs,
  sanitizeExport,
  serialize,
  validateRealm,
} from './keycloak-realm.mjs';
import { MAX_CLOCK_SKEW_S, jwtClaims, parseArgs, parseEnv, pkcePair } from './keycloak-smoke.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMPOSE_FILE = path.join(ROOT, 'infra/compose/docker-compose.dev.yml');
const KC_DIR = path.join(ROOT, 'infra/compose/keycloak');

/** @typedef {Record<string, unknown>} Obj */
/** @returns {Obj} */
const realm = () => loadRealm();
/** @param {Obj} r @param {string} username @returns {Obj} */
function user(r, username) {
  const u = /** @type {Obj[]} */ (r.users).find((x) => x.username === username);
  assert.ok(u, username);
  return u;
}
/** @param {Obj} r @param {string} clientId @returns {Obj} */
function client(r, clientId) {
  const c = /** @type {Obj[]} */ (r.clients).find((x) => x.clientId === clientId);
  assert.ok(c, clientId);
  return c;
}
/** @param {(r: Obj) => void} mutate @returns {string[]} */
function errorsAfter(mutate) {
  const r = realm();
  mutate(r);
  return validateRealm(r);
}

/** @typedef {{ services: Record<string, { image: string, command?: string[], environment?: Record<string, string>,
 *   ports?: { host_ip?: string, published?: string, target: number }[], depends_on?: Record<string, { condition: string }>,
 *   healthcheck?: { test: string[], start_period?: string }, volumes?: { source?: string, target: string, read_only?: boolean }[] }> }} ComposeConfig */
/** @returns {ComposeConfig} */
function composeConfig() {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('BW_DEV_')),
  );
  const dummy = Object.fromEntries(
    [
      'POSTGRES_SUPERUSER',
      'POSTGRES_APP',
      'POSTGRES_MIGRATOR',
      'VALKEY',
      'NEO4J',
      'KEYCLOAK_ADMIN',
      'KEYCLOAK_DB',
      'KEYCLOAK_TEST_USER',
      'MINIO_ROOT',
      'MINIO_APP',
      'GRAFANA_ADMIN',
    ].map((k) => [`BW_DEV_${k}_PASSWORD`, 'x-dummy-pass']),
  );
  for (const k of ['BFF', 'API', 'CI']) dummy[`BW_DEV_KEYCLOAK_${k}_SECRET`] = 'x-dummy';
  dummy.BW_DEV_INTERACTSH_TOKEN = 'x-dummy-token';
  dummy.BW_DEV_OPENBAO_ROOT_TOKEN = 'x-dummy-token';
  const res = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      'bwdev',
      '--env-file',
      '/dev/null',
      '-f',
      COMPOSE_FILE,
      'config',
      '--format',
      'json',
    ],
    { encoding: 'utf8', env: { ...clean, ...dummy } },
  );
  assert.equal(res.status, 0, res.stderr);
  /** @type {unknown} */
  const parsed = JSON.parse(res.stdout);
  return /** @type {ComposeConfig} */ (parsed);
}

describe('realm-export.json (DEVENV-004)', () => {
  it('is valid and in canonical (re-export) form', () => {
    assert.deepEqual(validateRealm(realm()), []);
    assert.equal(serialize(sanitizeExport(realm())), readFileSync(REALM_FILE, 'utf8'));
    assert.equal(main(['check']), 0);
  });

  it('defines every persona role, scoped tenant vs platform', () => {
    const roles = /** @type {{ realm: Obj[] }} */ (realm().roles).realm;
    const names = roles.map((r) => r.name);
    for (const r of [...TENANT_ROLES, ...PLATFORM_ROLES]) assert.ok(names.includes(r), r);
  });

  it('has every test user with its role (via groups) and the acme tenant attribute', () => {
    const r = realm();
    for (const [username, role] of Object.entries(TEST_USERS)) {
      const u = user(r, username);
      assert.ok(effectiveRoles(r, u).has(role), `${username} -> ${role}`);
      const creds = /** @type {Obj[]} */ (u.credentials);
      assert.deepEqual(creds, [
        { temporary: false, type: 'password', value: PASSWORD_PLACEHOLDER },
      ]);
      if (!PLATFORM_ROLES.includes(role)) assert.deepEqual(u.attributes, { tenant: [TENANT] });
    }
  });

  it('the Platform Operator has no tenant roles, no tenant attribute and no tenant group (§1.2)', () => {
    const r = realm();
    const op = user(r, 'operator@blackwing.test');
    assert.deepEqual([...effectiveRoles(r, op)], ['platform-operator']);
    assert.equal(op.attributes, undefined);
    assert.ok(/** @type {string[]} */ (op.groups).every((g) => !g.startsWith('/acme')));
    const e = errorsAfter((x) => {
      /** @type {string[]} */ (user(x, 'operator@blackwing.test').groups).push('/acme/auditors');
    });
    assert.ok(
      e.some((m) => m.includes('platform operator holds tenant roles auditor')),
      e.join('\n'),
    );
    const e2 = errorsAfter((x) => {
      user(x, 'operator@blackwing.test').attributes = { tenant: ['acme'] };
    });
    assert.ok(e2.some((m) => m.includes('no tenant attribute')));
  });

  it('tenant users can never hold the platform-operator role', () => {
    const e = errorsAfter((x) => {
      user(x, 'admin@acme.test').realmRoles = ['platform-operator'];
    });
    assert.ok(e.some((m) => m.includes('tenant user holds platform roles')));
  });

  it('BFF client: confidential, Auth Code + PKCE S256 only, exact redirect URIs', () => {
    const bff = client(realm(), BFF_CLIENT);
    assert.equal(bff.publicClient, false);
    assert.equal(bff.standardFlowEnabled, true);
    assert.equal(bff.directAccessGrantsEnabled, false);
    assert.equal(bff.implicitFlowEnabled, false);
    assert.equal(/** @type {Obj} */ (bff.attributes)['pkce.code.challenge.method'], 'S256');
    for (const [k, v] of /** @type {[string, unknown][]} */ ([
      ['pkce.code.challenge.method', 'plain'],
      ['directAccessGrantsEnabled', true],
      ['publicClient', true],
    ]))
      assert.notDeepEqual(
        errorsAfter((x) => {
          const c = client(x, BFF_CLIENT);
          if (k.includes('.')) /** @type {Obj} */ (c.attributes)[k] = v;
          else c[k] = v;
        }),
        [],
        k,
      );
  });

  it('edge case: redirect URI mismatch -> URIs stay in sync with *.bw.localhost (DEVENV-013)', () => {
    // The Traefik TLS proxy's default HTTPS host port (DEVENV-013) must be a registered origin.
    const composeText = readFileSync(COMPOSE_FILE, 'utf8');
    const tlsPort = /BW_DEV_TRAEFIK_HTTPS_PORT:-(\d+)\}:443/.exec(composeText)?.[1];
    assert.ok(tlsPort, 'traefik HTTPS port default not found');
    assert.deepEqual(CONSOLE_ORIGINS, [
      'https://app.bw.localhost',
      `https://app.bw.localhost:${tlsPort}`,
      'http://localhost:3000',
    ]);
    assert.ok(
      readFileSync(path.join(ROOT, 'infra/compose/tls/traefik/dynamic.yml'), 'utf8').includes(
        'app.bw.localhost',
      ),
    );
    const bff = client(realm(), BFF_CLIENT);
    assert.deepEqual(
      bff.redirectUris,
      CONSOLE_ORIGINS.map((o) => `${o}${BFF_CALLBACK_PATH}`).sort(),
    );
    const wild = errorsAfter((x) => {
      client(x, BFF_CLIENT).redirectUris = [
        'https://app.bw.localhost/*',
        'http://localhost:3000/auth/callback',
      ];
    });
    assert.ok(wild.some((m) => m.includes('redirectUris must be exactly')));
    assert.ok(wild.some((m) => m.includes('wildcard')));
    const drift = errorsAfter((x) => {
      client(x, BFF_CLIENT).webOrigins = ['*'];
    });
    assert.ok(drift.some((m) => m.includes('webOrigins')));
  });

  it('API is a resource server only; CI is client-credentials only with a ci-pipeline service account', () => {
    const r = realm();
    const sa = /** @type {Obj[]} */ (r.users).find((u) => u.serviceAccountClientId === CI_CLIENT);
    assert.ok(sa && effectiveRoles(r, sa).has('ci-pipeline'));
    assert.notDeepEqual(
      errorsAfter((x) => void (client(x, 'bw-api').standardFlowEnabled = true)),
      [],
    );
    assert.notDeepEqual(
      errorsAfter((x) => void (client(x, CI_CLIENT).directAccessGrantsEnabled = true)),
      [],
    );
  });

  it('tokens carry the tenant claim and the bw-api audience (mappers present)', () => {
    const e = errorsAfter((x) => {
      client(x, BFF_CLIENT).protocolMappers = [];
    });
    assert.ok(e.some((m) => m.includes('tenant claim mapper')));
    assert.ok(e.some((m) => m.includes('audience mapper')));
  });

  it('users cannot edit their own tenant attribute (admin-only in the user profile)', () => {
    const e = errorsAfter((x) => {
      const ups = /** @type {Record<string, Obj[]>} */ (x.components)[
        'org.keycloak.userprofile.UserProfileProvider'
      ];
      const cfg = /** @type {Record<string, string[]>} */ (ups?.[0]?.config);
      /** @type {unknown} */
      const raw = JSON.parse(cfg['kc.user.profile.config']?.[0] ?? '{}');
      const parsed =
        /** @type {{ attributes: { name: string; permissions: { edit: string[] } }[] }} */ (raw);
      for (const a of parsed.attributes)
        if (a.name === 'tenant') a.permissions.edit = ['admin', 'user'];
      cfg['kc.user.profile.config'] = [JSON.stringify(parsed)];
    });
    assert.ok(e.some((m) => m.includes('editable by admins only')));
  });

  it('commits no secrets: only ${BW_DEV_KEYCLOAK_*} placeholders, no hashes, no ids', () => {
    const text = readFileSync(REALM_FILE, 'utf8');
    for (const m of text.matchAll(/\$\{([^}]+)\}/g))
      assert.match(m[1] ?? '', /^BW_DEV_KEYCLOAK_[A-Z_]+$/);
    assert.ok(errorsAfter((x) => void (client(x, BFF_CLIENT).secret = 'real-secret')).length > 0);
    assert.ok(
      errorsAfter((x) => {
        user(x, 'dev@acme.test').credentials = [
          { type: 'password', secretData: '{}', credentialData: '{}' },
        ];
      }).some((m) => m.includes('hashed credentials')),
    );
  });

  it('dev only: no mandatory MFA (no required actions); staging/prod requirement documented', () => {
    assert.ok(
      errorsAfter((x) => void (user(x, 'dev@acme.test').requiredActions = ['CONFIGURE_TOTP']))
        .length > 0,
    );
    const readme = readFileSync(path.join(ROOT, 'infra/compose/README.md'), 'utf8');
    assert.match(readme, /staging and prod(uction)? require MFA/i);
    assert.match(readme, /IdP brokering/);
  });

  it('edge case: password login leaking to non-dev -> realm is blackwing-dev, flagged dev, .test users only', () => {
    assert.equal(realm().realm, REALM);
    assert.ok(errorsAfter((x) => void (x.realm = 'blackwing')).some((m) => m.includes('dev only')));
    assert.ok(errorsAfter((x) => void (x.attributes = {})).some((m) => /bw.environment/.test(m)));
    assert.ok(errorsAfter((x) => void (x.registrationAllowed = true)).length > 0);
    const extra = errorsAfter((x) => {
      /** @type {Obj[]} */ (x.users).push({ username: 'someone@acme.com', enabled: true });
    });
    assert.ok(extra.some((m) => m.includes('unexpected user')));
    assert.ok(extra.some((m) => m.includes('reserved .test TLD')));
  });
});

describe('re-export workflow', () => {
  /** Simulates what `kc.sh export` emits on top of the committed realm. @returns {Obj} */
  function noisyExport() {
    const r = structuredClone(realm());
    /** @param {unknown} v @param {number} depth */
    const addIds = (v, depth = 0) => {
      if (Array.isArray(v)) for (const x of v) addIds(x, depth + 1);
      else if (v && typeof v === 'object') {
        const o = /** @type {Obj} */ (v);
        if (depth > 0 && ('name' in o || 'clientId' in o || 'username' in o))
          o.id = 'b1e2f0c4-0000-4000-8000-000000000000';
        for (const x of Object.values(o)) addIds(x, depth + 1);
      }
    };
    addIds(r);
    r.id = 'realm-uuid';
    r.notBefore = 0;
    r.defaultSignatureAlgorithm = 'RS256';
    r.requiredActions = [{ alias: 'CONFIGURE_TOTP', defaultAction: false }];
    r.attributes = { 'bw.environment': 'dev', cibaBackchannelTokenDeliveryMode: 'poll' };
    const roles = /** @type {{ realm: Obj[] }} */ (r.roles);
    roles.realm.push(
      { name: 'offline_access', composite: false },
      { name: `default-roles-${REALM}`, composite: true },
    );
    for (const u of /** @type {Obj[]} */ (r.users)) {
      u.createdTimestamp = 1760000000000;
      u.realmRoles = [.../** @type {string[]} */ (u.realmRoles ?? []), `default-roles-${REALM}`];
      if (!u.serviceAccountClientId)
        u.credentials = [
          {
            type: 'password',
            secretData: '{"value":"hash"}',
            credentialData: '{"hashIterations":5}',
          },
        ];
    }
    const clients = /** @type {Obj[]} */ (r.clients);
    for (const c of clients) {
      c.secret = 'actual-dev-secret-from-env';
      c.attributes = {
        .../** @type {Obj} */ (c.attributes),
        'client.secret.creation.time': '1760000000',
      };
      c.defaultClientScopes = ['profile', 'email', 'roles'];
    }
    clients.push(
      { clientId: 'account-console', publicClient: true },
      { clientId: 'realm-management', bearerOnly: true },
    );
    const ups = /** @type {Record<string, Obj[]>} */ (r.components)[
      'org.keycloak.userprofile.UserProfileProvider'
    ];
    const cfg = /** @type {Record<string, string[]>} */ (ups?.[0]?.config);
    cfg['kc.user.profile.config'] = [
      JSON.stringify(JSON.parse(cfg['kc.user.profile.config']?.[0] ?? '{}'), null, 4),
    ];
    /** @type {Record<string, Obj[]>} */ (r.components)['org.keycloak.keys.KeyProvider'] = [
      { name: 'rsa', config: { privateKey: ['MII...'] } },
    ];
    return r;
  }

  it('turns a raw export (ids, real secrets, hashes, built-ins) back into the committed file', () => {
    const out = serialize(sanitizeExport(noisyExport()));
    assert.equal(out, readFileSync(REALM_FILE, 'utf8'));
    assert.doesNotMatch(out, /actual-dev-secret|secretData|privateKey|"id"|createdTimestamp/);
  });

  it('is idempotent', () => {
    const once = sanitizeExport(noisyExport());
    assert.deepEqual(sanitizeExport(once), once);
  });

  it('CLI: export/reset target the dev stack; reset needs --yes; unknown commands rejected', () => {
    assert.deepEqual(parseCliArgs(['--project', 'p', '--yes']).project, 'p');
    assert.throws(() => parseCliArgs(['--bogus']), /unknown/);
    assert.equal(main(['reset']), 2);
    assert.equal(main(['explode']), 2);
  });
});

describe('Keycloak compose service', () => {
  const c = composeConfig();
  const kc = c.services.keycloak;
  const db = c.services['keycloak-db'];

  it('pins Keycloak 26 by digest, uses the dev Postgres and imports the realm', () => {
    assert.ok(kc && db);
    assert.match(kc.image, /^quay\.io\/keycloak\/keycloak:26\.[\d.]+@sha256:[0-9a-f]{64}$/);
    assert.deepEqual(kc.command, ['start-dev', '--import-realm']);
    assert.equal(kc.environment?.KC_DB, 'postgres');
    assert.equal(kc.environment.KC_DB_URL, 'jdbc:postgresql://postgres:5432/keycloak');
    const vol = (kc.volumes ?? []).find(
      (v) => v.target === '/opt/keycloak/data/import/realm-export.json',
    );
    assert.ok(vol?.read_only && vol.source === REALM_FILE);
    assert.equal(kc.depends_on?.['keycloak-db']?.condition, 'service_completed_successfully');
    assert.equal(db.depends_on?.postgres?.condition, 'service_healthy');
  });

  it('exposes 8080 on 127.0.0.1:18080 only', () => {
    assert.deepEqual(
      (kc?.ports ?? []).map((p) => [p.host_ip, p.published, p.target]),
      [['127.0.0.1', '18080', 8080]],
    );
  });

  it('edge case: slow first boot -> /health/ready healthcheck with a generous start_period', () => {
    const hc = kc?.healthcheck;
    assert.match(hc?.test.join(' ') ?? '', /\/health\/ready/);
    const m = /^(?:(\d+)m)?(?:(\d+)s)?$/.exec(hc?.start_period ?? '');
    assert.ok(m && Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) >= 120, String(hc?.start_period));
    assert.equal(kc?.environment?.KC_HEALTH_ENABLED, 'true');
    assert.equal(kc.environment.KC_METRICS_ENABLED, 'true');
  });

  it('edge case: realm import on an existing DB -> import skips existing realms; DB init is idempotent', () => {
    assert.ok(
      !(kc?.command ?? []).some((a) => a.includes('override')),
      'never --override (would wipe dev changes)',
    );
    const init = readFileSync(path.join(KC_DIR, 'db-init.sh'), 'utf8');
    assert.match(init, /WHERE NOT EXISTS \(SELECT 1 FROM pg_roles/);
    assert.match(init, /WHERE NOT EXISTS \(SELECT 1 FROM pg_database/);
    assert.match(init, /BW_KEYCLOAK_DB_RESET/);
    assert.match(init, /NOBYPASSRLS/);
    const readme = readFileSync(path.join(ROOT, 'infra/compose/README.md'), 'utf8');
    assert.match(readme, /pnpm dev:keycloak:reset --yes/);
  });

  it('passes every realm placeholder to the container (and none has a default)', () => {
    const text = readFileSync(REALM_FILE, 'utf8');
    const compose = readFileSync(COMPOSE_FILE, 'utf8');
    for (const m of new Set(
      [...text.matchAll(/\$\{(BW_DEV_KEYCLOAK_[A-Z_]+)\}/g)].map((x) => x[1] ?? ''),
    )) {
      assert.ok(kc?.environment?.[m], m);
      assert.match(compose, new RegExp(`\\$\\{${m}:\\?`), `${m} must be required`);
    }
  });
});

describe('keycloak-smoke helpers', () => {
  it('builds RFC 7636 S256 PKCE pairs', () => {
    const { verifier, challenge } = pkcePair();
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    assert.notEqual(pkcePair().verifier, verifier);
  });

  it('decodes JWT claims and env files; parses its arguments', () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ tenant: 'acme' })).toString('base64url')}.y`;
    assert.deepEqual(jwtClaims(jwt), { tenant: 'acme' });
    assert.throws(() => jwtClaims('nope'), /malformed/);
    assert.deepEqual(parseEnv('# c\nA=1\nB=\n'), { A: '1', B: '' });
    assert.equal(parseArgs(['--restart', '--project', 'p']).restart, true);
    assert.throws(() => parseArgs(['--bogus']), /unknown/);
  });

  it('edge case: clock skew -> bounded iat tolerance, documented NTP/host time fix', () => {
    assert.equal(MAX_CLOCK_SKEW_S, 60, 'iat tolerance stays bounded (≤ 2 min)');
    const readme = readFileSync(path.join(ROOT, 'infra/compose/README.md'), 'utf8');
    assert.match(readme, /clock skew/i);
    assert.match(readme, /NTP|hwclock/);
  });
});
