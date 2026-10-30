import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  brokerRedirectUri,
  demoMappers,
  identityProviderRepresentation,
  missingCredentialsMessage,
  parseEnvText,
  publicKeycloakBase,
  readGoogleCredentials,
  syncGoogleIdp,
} from './keycloak-google-idp.mjs';

/** @param {number} status @param {unknown} [body] */
const json = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * @typedef {{ id?: string, name?: string, providerId?: string, enabled?: boolean, internalId?: string,
 *   config?: Record<string, string> }} Rep
 */

/**
 * A fake Keycloak admin API: an in-memory provider, mappers and roles. Records every call (no secret logged).
 * @param {{ idp?: Rep }} [seed]
 */
function fakeKeycloak(seed = {}) {
  /** @type {{ idp: Rep | undefined, mappers: Rep[], roles: Set<string>, calls: string[] }} */
  const state = {
    idp: seed.idp,
    mappers: [],
    roles: new Set(['appsec-engineer', 'auditor']),
    calls: [],
  };
  /** @type {typeof fetch} */
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    state.calls.push(`${method} ${u.pathname}`);
    if (u.pathname.endsWith('/protocol/openid-connect/token'))
      return json(200, { access_token: 'tok' });
    const p = u.pathname.replace('/admin/realms/blackwing-dev', '');
    /** @type {Rep & { name: string }} */
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (p === '/identity-provider/instances/google' && method === 'GET')
      return state.idp ? json(200, state.idp) : json(404);
    if (p === '/identity-provider/instances' && method === 'POST') {
      state.idp = { ...body, internalId: 'int-1' };
      return json(201);
    }
    if (p === '/identity-provider/instances/google' && method === 'PUT') {
      state.idp = body;
      return json(204);
    }
    if (p === '/identity-provider/instances/google/mappers' && method === 'GET')
      return json(200, state.mappers);
    if (p === '/identity-provider/instances/google/mappers' && method === 'POST') {
      state.mappers.push({ ...body, id: `m${state.mappers.length}` });
      return json(201);
    }
    const mapper = p.match(/^\/identity-provider\/instances\/google\/mappers\/(.+)$/);
    if (mapper && method === 'PUT') {
      state.mappers = state.mappers.map((m) => (m.id === mapper[1] ? body : m));
      return json(204);
    }
    if (p.startsWith('/roles/')) return state.roles.has(p.slice(7)) ? json(200, {}) : json(404);
    if (p === '/roles' && method === 'POST') {
      state.roles.add(String(body.name));
      return json(201);
    }
    return json(500);
  };
  return { state, fetchFn };
}

const creds = { clientId: 'client-id-for-test', clientSecret: 'secret-for-test' };
const input = (fetchFn, extra = {}) => ({
  base: 'http://127.0.0.1:18080',
  creds,
  adminUser: 'admin',
  adminPassword: 'pw',
  fetchFn,
  ...extra,
});

describe('keycloak-google-idp: configuration', () => {
  it('parses KEY=VALUE lines, skipping comments and stripping one pair of quotes', () => {
    assert.deepEqual(parseEnvText('# c\nA=1\nB="two"\n\nC=\n'), { A: '1', B: 'two', C: '' });
  });

  it('prefers a set process value and never lets an empty one hide the file', () => {
    assert.deepEqual(
      readGoogleCredentials(
        { BW_DEV_GOOGLE_CLIENT_ID: 'p' },
        { BW_DEV_GOOGLE_CLIENT_ID: 'f', BW_DEV_GOOGLE_CLIENT_SECRET: 's' },
      ),
      {
        clientId: 'p',
        clientSecret: 's',
      },
    );
    assert.deepEqual(
      readGoogleCredentials({ BW_DEV_GOOGLE_CLIENT_ID: '' }, { BW_DEV_GOOGLE_CLIENT_ID: 'f' }),
      {
        clientId: 'f',
        clientSecret: '',
      },
    );
  });

  it('builds the broker redirect URI from the public Keycloak origin', () => {
    assert.equal(publicKeycloakBase({ BW_DEV_KEYCLOAK_PORT: '18080' }), 'http://localhost:18080');
    assert.equal(
      publicKeycloakBase({ BW_DEV_KEYCLOAK_PUBLIC_URL: 'https://kc.example/' }),
      'https://kc.example',
    );
    assert.equal(
      brokerRedirectUri('http://localhost:18080'),
      'http://localhost:18080/realms/blackwing-dev/broker/google/endpoint',
    );
  });

  it('explains what to set and which Google URIs to register, without any secret', () => {
    const msg = missingCredentialsMessage('http://localhost:18080');
    assert.match(msg, /BW_DEV_GOOGLE_CLIENT_ID/);
    assert.match(msg, /pnpm demo google/);
    assert.ok(msg.includes('http://localhost:18080/realms/blackwing-dev/broker/google/endpoint'));
    assert.ok(msg.includes('Authorised JavaScript origin http://localhost:18080'));
    assert.equal(msg.includes('\n'), false, 'one paragraph');
  });

  it('uses the agreed provider settings and the demo-only mappers', () => {
    const rep = identityProviderRepresentation(creds);
    assert.equal(rep.providerId, 'google');
    assert.equal(rep.trustEmail, false);
    assert.equal(rep.storeToken, false);
    assert.equal(rep.hideOnLogin, false);
    assert.equal(rep.config.defaultScope, 'openid email profile');
    assert.equal(rep.config.syncMode, 'IMPORT');
    const mappers = demoMappers();
    assert.ok(
      mappers.some(
        (m) => m.config.attribute === 'tenant' && m.config['attribute.value'] === 'acme',
      ),
    );
    assert.ok(mappers.some((m) => m.config.role === 'bw-demo-google'));
  });
});

describe('keycloak-google-idp: upsert', () => {
  it('creates the provider and the demo mappers when absent, then verifies them', async () => {
    const kc = fakeKeycloak();
    const result = await syncGoogleIdp(input(kc.fetchFn));
    assert.equal(result.created, true);
    assert.equal(kc.state.idp?.providerId, 'google');
    assert.equal(kc.state.idp?.config?.clientSecret, creds.clientSecret);
    assert.equal(kc.state.mappers.length, 4);
    assert.ok(kc.state.roles.has('bw-demo-google'), 'marker realm role is created');
  });

  it('is idempotent: a second run updates in place and keeps unrelated live settings', async () => {
    const kc = fakeKeycloak({
      idp: {
        alias: 'google',
        providerId: 'google',
        enabled: true,
        internalId: 'int-9',
        config: { syncMode: 'IMPORT', keepMe: 'yes' },
      },
    });
    await syncGoogleIdp(input(kc.fetchFn));
    const again = await syncGoogleIdp(input(kc.fetchFn));
    assert.equal(again.created, false);
    assert.equal(kc.state.idp?.internalId, 'int-9');
    assert.equal(kc.state.idp?.config?.keepMe, 'yes');
    assert.equal(kc.state.mappers.length, 4, 'mappers are updated, not duplicated');
    assert.ok(
      kc.state.calls.some(
        (c) => c === 'PUT /admin/realms/blackwing-dev/identity-provider/instances/google',
      ),
    );
  });

  it('fails with status codes only, never echoing the secret', async () => {
    const fetchFn = async (url) =>
      new URL(url).pathname.endsWith('/token')
        ? json(200, { access_token: 't' })
        : json(403, { error: creds.clientSecret });
    await assert.rejects(syncGoogleIdp(input(fetchFn)), (err) => {
      assert.match(err.message, /HTTP 403/);
      assert.equal(err.message.includes(creds.clientSecret), false);
      return true;
    });
  });
});
