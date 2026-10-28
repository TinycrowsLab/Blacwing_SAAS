import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from '@blackwing/logger';

import { createKeycloakMetrics, type KeycloakMetrics } from '../metrics.js';
import {
  ACS_URL,
  discoveryDocument,
  EXPIRED_CERT_B64,
  fakeFetch,
  idpMetadataXml,
  jsonResponse,
  NOW,
  OIDC_DISCOVERY_URL,
  OIDC_ISSUER,
  spDescriptorXml,
  VALID_CERT_B64,
  xmlResponse,
} from './fixtures.test-helpers.js';
import {
  type IdentityProviderAuditEvent,
  type IdentityProviderPrincipal,
  IdentityProviderService,
} from './identity-provider.service.js';

import type { KeycloakAdminClient, KeycloakAdminOp } from '../admin-client.js';

// OFFLINE-STUB(online-porting #904): Keycloak is a stateful in-memory fake of the admin endpoints the service calls.
// The live Keycloak 26 behaviour (organisation links, mapper PUT bodies, SAML config keys) is verified online.

const TENANT_ID = '0190c2a4-0000-7000-8000-000000000001';
const ORG_ID = '0190c2a4-0000-7000-8000-0000000000aa';
const USER_ID = '0190c2a4-0000-7000-8000-0000000000bb';
const CLIENT_SECRET = 'idp-client-secret-value-9f2c';
const SECRET_REF = 'secret/data/tenants/acme/sso/oidc';
const ADMIN: IdentityProviderPrincipal = {
  subjectId: USER_ID,
  tenantId: TENANT_ID,
  roles: ['org_admin'],
};
const APPSEC: IdentityProviderPrincipal = {
  subjectId: USER_ID,
  tenantId: TENANT_ID,
  roles: ['appsec_engineer'],
};

interface Rep {
  alias: string;
  providerId: string;
  enabled: boolean;
  config: Record<string, string>;
}
interface Mapper {
  id: string;
  name: string;
  identityProviderMapper: string;
  config: Record<string, string>;
}
type Result =
  | { kind: 'ok'; body: unknown; location: string | undefined }
  | { kind: 'not_found' }
  | { kind: 'conflict' };

/** A stateful stand-in for the Keycloak admin endpoints used by the identity provider service. */
class FakeKeycloak implements KeycloakAdminClient {
  readonly instances = new Map<string, Rep>();
  readonly links = new Map<string, Set<string>>([[ORG_ID, new Set()]]);
  readonly mappers = new Map<string, Mapper[]>();
  readonly calls: { op: KeycloakAdminOp; method: string; path: string; body: unknown }[] = [];
  failLink = false;
  private nextId = 1;

  request(
    op: KeycloakAdminOp,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Result> {
    this.calls.push({ op, method, path, body });
    return Promise.resolve(this.route(method, path, body));
  }

  writes(): number {
    return this.calls.filter((call) => call.method !== 'GET').length;
  }

  private route(method: string, path: string, body: unknown): Result {
    const instance = /^identity-provider\/instances\/([^/]+)$/.exec(path)?.[1];
    if (instance !== undefined) {
      const existing = this.instances.get(instance);
      if (method === 'GET') return existing === undefined ? { kind: 'not_found' } : ok(existing);
      if (method === 'PUT') {
        if (existing === undefined) return { kind: 'not_found' };
        this.instances.set(instance, body as Rep);
        return ok(undefined);
      }
      if (method === 'DELETE') {
        if (existing === undefined) return { kind: 'not_found' };
        this.instances.delete(instance);
        this.mappers.delete(instance);
        return ok(undefined);
      }
    }
    if (path === 'identity-provider/instances' && method === 'POST') {
      const rep = body as Rep;
      if (this.instances.has(rep.alias)) return { kind: 'conflict' };
      this.instances.set(rep.alias, rep);
      return ok(undefined);
    }
    const links = /^organizations\/([^/]+)\/identity-providers(?:\/([^/]+))?$/.exec(path);
    if (links !== null) {
      const org = links[1] ?? '';
      const alias = links[2];
      const set = this.links.get(org);
      if (set === undefined) return { kind: 'not_found' };
      if (method === 'GET') return ok([...set].map((value) => ({ alias: value })));
      if (method === 'POST') {
        if (this.failLink) throw new Error('keycloak link failed');
        set.add(String(body));
        return ok(undefined);
      }
      if (method === 'DELETE' && alias !== undefined) {
        if (!set.delete(alias)) return { kind: 'not_found' };
        return ok(undefined);
      }
    }
    const mapperRoute = /^identity-provider\/instances\/([^/]+)\/mappers(?:\/([^/]+))?$/.exec(path);
    if (mapperRoute !== null) {
      const alias = mapperRoute[1] ?? '';
      const mapperId = mapperRoute[2];
      const list = this.mappers.get(alias) ?? [];
      this.mappers.set(alias, list);
      if (method === 'GET') return ok(list);
      if (method === 'POST') {
        const created: Mapper = { ...(body as Omit<Mapper, 'id'>), id: `m${this.nextId++}` };
        list.push(created);
        return ok(undefined, `/x/${created.id}`);
      }
      const index = list.findIndex((mapper) => mapper.id === mapperId);
      if (index === -1) return { kind: 'not_found' };
      if (method === 'PUT') list[index] = body as Mapper;
      if (method === 'DELETE') list.splice(index, 1);
      return ok(undefined);
    }
    return { kind: 'not_found' };
  }
}

const ok = (body: unknown, location?: string): Result => ({ kind: 'ok', body, location });

const sink = (): {
  readonly events: IdentityProviderAuditEvent[];
  record: (e: IdentityProviderAuditEvent) => Promise<void>;
} => {
  const events: IdentityProviderAuditEvent[] = [];
  return { events, record: (event) => Promise.resolve(void events.push(event)) };
};

interface Harness {
  readonly service: IdentityProviderService;
  readonly keycloak: FakeKeycloak;
  readonly audit: ReturnType<typeof sink>;
  readonly metrics: KeycloakMetrics;
  readonly fetched: string[];
  readonly logged: string[];
}

function harness(routes: Parameters<typeof fakeFetch>[0] = {}): Harness {
  const keycloak = new FakeKeycloak();
  const audit = sink();
  const metrics = createKeycloakMetrics();
  const logged: string[] = [];
  const logStream = new Writable({
    write(chunk: Buffer, _enc, done) {
      logged.push(chunk.toString('utf8'));
      done();
    },
  });
  const logger = createLogger('idp-test', { destination: logStream });
  const { fetch, seen } = fakeFetch({
    [OIDC_DISCOVERY_URL]: () => jsonResponse(discoveryDocument()),
    ...routes,
  });
  const service = new IdentityProviderService({
    client: keycloak,
    audit,
    metrics,
    logger,
    organizationIdFor: (tenantId) => Promise.resolve(tenantId === TENANT_ID ? ORG_ID : undefined),
    readSecretRef: (ref) =>
      ref === SECRET_REF
        ? Promise.resolve(CLIENT_SECRET)
        : Promise.reject(new Error('unexpected secret ref')),
    fetch,
    realmUrl: 'https://id.example.test/realms/blackwing',
    now: () => NOW,
    timeoutMs: 1000,
  });
  return { service, keycloak, audit, metrics, fetched: seen, logged };
}

const oidcInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'oidc',
  alias: 'acme-oidc',
  issuer: OIDC_ISSUER,
  clientId: 'blackwing-acme',
  clientSecretRef: SECRET_REF,
  ...overrides,
});

const samlInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'saml',
  alias: 'acme-saml',
  metadata: { source: 'xml', xml: idpMetadataXml({ validUntil: '2027-01-01T00:00:00Z' }) },
  ...overrides,
});

describe('IdentityProviderService: authorisation and tenant scoping', () => {
  it('lets only an org_admin configure single sign-on', async () => {
    const h = harness();
    await expect(h.service.configure(APPSEC, oidcInput())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(h.service.remove(APPSEC, 'acme-oidc')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(h.service.exportSpMetadata(APPSEC, 'acme-saml')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.keycloak.writes()).toBe(0);
    expect(h.audit.events).toHaveLength(0);
  });

  it('refuses a tenant with no provisioned organisation, without touching Keycloak', async () => {
    const h = harness();
    const stranger: IdentityProviderPrincipal = {
      ...ADMIN,
      tenantId: '0190c2a4-0000-7000-8000-00000000cccc',
    };
    await expect(h.service.configure(stranger, oidcInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.keycloak.calls).toHaveLength(0);
  });

  it('refuses to change a provider that belongs to another organisation, without revealing it', async () => {
    const h = harness();
    h.keycloak.instances.set('acme-oidc', {
      alias: 'acme-oidc',
      providerId: 'oidc',
      enabled: true,
      config: { clientId: 'other-tenant' },
    });
    await expect(h.service.configure(ADMIN, oidcInput())).rejects.toMatchObject({
      code: 'KEYCLOAK_CONFLICT',
    });
    expect(h.keycloak.writes()).toBe(0);
  });

  it('refuses to delete another organisation’s provider and leaves it in place', async () => {
    const h = harness();
    h.keycloak.instances.set('other-saml', {
      alias: 'other-saml',
      providerId: 'saml',
      enabled: true,
      config: {},
    });
    const result = await h.service.remove(ADMIN, 'other-saml');
    expect(result).toEqual({ changed: false });
    expect(h.keycloak.instances.has('other-saml')).toBe(true);
    expect(h.keycloak.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('refuses SAML metadata export for another organisation’s provider', async () => {
    const h = harness();
    h.keycloak.instances.set('other-saml', {
      alias: 'other-saml',
      providerId: 'saml',
      enabled: true,
      config: {},
    });
    await expect(h.service.exportSpMetadata(ADMIN, 'other-saml')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.fetched).toHaveLength(0);
  });
});

describe('IdentityProviderService: generic OIDC', () => {
  it('creates a provider from the discovery document, links it to the org and maps email, name and groups', async () => {
    const h = harness();
    const result = await h.service.configure(ADMIN, oidcInput({ scopes: ['openid', 'email'] }));
    expect(result).toEqual({ alias: 'acme-oidc', type: 'oidc', created: true, changed: true });

    const rep = h.keycloak.instances.get('acme-oidc');
    expect(rep).toMatchObject({ providerId: 'oidc', enabled: true });
    expect(rep?.config).toMatchObject({
      clientId: 'blackwing-acme',
      clientSecret: CLIENT_SECRET,
      issuer: OIDC_ISSUER,
      authorizationUrl: `${OIDC_ISSUER}/authorize`,
      tokenUrl: `${OIDC_ISSUER}/token`,
      jwksUrl: `${OIDC_ISSUER}/jwks`,
      validateSignature: 'true',
      pkceEnabled: 'true',
      pkceMethod: 'S256',
      defaultScope: 'openid email',
    });
    expect(h.keycloak.links.get(ORG_ID)?.has('acme-oidc')).toBe(true);
    const names = h.keycloak.mappers.get('acme-oidc')?.map((mapper) => mapper.name);
    expect(names).toEqual(['bw-email', 'bw-name', 'bw-groups']);
    expect(h.keycloak.mappers.get('acme-oidc')?.[0]?.config).toEqual({
      claim: 'email',
      'user.attribute': 'email',
      syncMode: 'INHERIT',
    });
  });

  it('never trusts an unverified email to link accounts', async () => {
    const h = harness();
    await h.service.configure(ADMIN, oidcInput());
    expect(h.keycloak.instances.get('acme-oidc')).toMatchObject({ enabled: true });
    expect(h.keycloak.calls.find((call) => call.op === 'idp_create')?.body).toMatchObject({
      trustEmail: false,
    });
  });

  it('rejects a scope list without openid and an unknown field such as a switch for signature checks', async () => {
    const h = harness();
    await expect(
      h.service.configure(ADMIN, oidcInput({ scopes: ['email'] })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      h.service.configure(ADMIN, oidcInput({ validateSignature: false })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.keycloak.writes()).toBe(0);
  });

  it('rejects a secret reference that is not an OpenBao path, and never reads the secret for it', async () => {
    const h = harness();
    await expect(
      h.service.configure(ADMIN, oidcInput({ clientSecretRef: '../etc/passwd' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.keycloak.writes()).toBe(0);
  });

  it('is a fail-closed, retryable error when the discovery URL is unreachable, and writes nothing', async () => {
    const h = harness({
      [OIDC_DISCOVERY_URL]: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(h.service.configure(ADMIN, oidcInput())).rejects.toMatchObject({
      code: 'EXTERNAL_BACKEND_UNAVAILABLE',
    });
    expect(h.keycloak.writes()).toBe(0);
    expect(h.audit.events).toHaveLength(0);
  });

  it('refuses a discovery document that names another issuer, and writes nothing', async () => {
    const h = harness({
      [OIDC_DISCOVERY_URL]: () =>
        jsonResponse(discoveryDocument({ issuer: 'https://evil.example.test' })),
    });
    await expect(h.service.configure(ADMIN, oidcInput())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(h.keycloak.writes()).toBe(0);
  });

  it('re-sends the client secret on every call, so a rotated secret takes effect, and audits it as applied', async () => {
    const h = harness();
    await h.service.configure(ADMIN, oidcInput());
    const second = await h.service.configure(ADMIN, oidcInput());
    expect(second).toEqual({ alias: 'acme-oidc', type: 'oidc', created: false, changed: true });
    expect(h.keycloak.calls.filter((call) => call.op === 'idp_update')).toHaveLength(1);
    expect(h.audit.events.map((event) => [event.op, event.outcome])).toEqual([
      ['create', 'applied'],
      ['update', 'applied'],
    ]);
  });

  it('removes a stale managed (bw-) mapper but leaves mappers it does not own', async () => {
    const h = harness();
    await h.service.configure(ADMIN, oidcInput());
    h.keycloak.mappers.get('acme-oidc')?.push({
      id: 'custom',
      name: 'customer-own-mapper',
      identityProviderMapper: 'oidc-user-attribute-idp-mapper',
      config: {},
    });
    h.keycloak.mappers.get('acme-oidc')?.push({
      id: 'legacy',
      name: 'bw-legacy',
      identityProviderMapper: 'oidc-user-attribute-idp-mapper',
      config: {},
    });
    await h.service.configure(ADMIN, oidcInput());
    const names = h.keycloak.mappers.get('acme-oidc')?.map((mapper) => mapper.name);
    expect(names).toEqual(['bw-email', 'bw-name', 'bw-groups', 'customer-own-mapper']);
  });

  it('never logs or audits the client secret', async () => {
    const h = harness();
    await h.service.configure(ADMIN, oidcInput());
    expect(JSON.stringify(h.audit.events)).not.toContain(CLIENT_SECRET);
    expect(h.logged.join('\n')).not.toContain(CLIENT_SECRET);
  });

  it('refuses to change the provider type of an existing alias', async () => {
    const h = harness();
    h.keycloak.instances.set('acme-oidc', {
      alias: 'acme-oidc',
      providerId: 'saml',
      enabled: true,
      config: {},
    });
    h.keycloak.links.get(ORG_ID)?.add('acme-oidc');
    await expect(h.service.configure(ADMIN, oidcInput())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('IdentityProviderService: SAML', () => {
  it('creates a SAML provider that requires signed assertions and records the certificate in use', async () => {
    const h = harness();
    const result = await h.service.configure(
      ADMIN,
      samlInput({ nameIdFormat: 'persistent', clockSkewSeconds: 30 }),
    );
    expect(result).toMatchObject({
      alias: 'acme-saml',
      type: 'saml',
      created: true,
      changed: true,
    });

    const rep = h.keycloak.instances.get('acme-saml');
    expect(rep?.config).toMatchObject({
      entityId: 'https://idp.example.test/saml',
      singleSignOnServiceUrl: 'https://idp.example.test/sso',
      singleLogoutServiceUrl: 'https://idp.example.test/slo',
      signingCertificate: VALID_CERT_B64,
      validateSignature: 'true',
      wantAssertionsSigned: 'true',
      wantAssertionsEncrypted: 'false',
      nameIDPolicyFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      allowedClockSkew: '30',
    });
    expect(
      h.keycloak.mappers.get('acme-saml')?.map((mapper) => mapper.identityProviderMapper),
    ).toEqual([
      'saml-user-attribute-idp-mapper',
      'saml-user-attribute-idp-mapper',
      'saml-user-attribute-idp-mapper',
    ]);
    const days = await h.metrics.signingCertExpiryDays.get();
    expect(days.values[0]?.labels).toEqual({ alias: 'acme-saml' });
    expect(days.values[0]?.value).toBeGreaterThan(0);
  });

  it('cannot be configured to accept unsigned assertions: wantAssertionsSigned is not an input', async () => {
    const h = harness();
    await expect(
      h.service.configure(ADMIN, samlInput({ wantAssertionsSigned: false })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.keycloak.writes()).toBe(0);
  });

  it('bounds the clock skew to 0 to 300 seconds', async () => {
    const h = harness();
    await expect(
      h.service.configure(ADMIN, samlInput({ clockSkewSeconds: 301 })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      h.service.configure(ADMIN, samlInput({ clockSkewSeconds: -1 })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.keycloak.writes()).toBe(0);
  });

  it('fetches metadata by URL over https, bounded, and refuses a private metadata address', async () => {
    const url = 'https://idp.example.test/metadata.xml';
    const h = harness({ [url]: () => xmlResponse(idpMetadataXml()) });
    await h.service.configure(ADMIN, samlInput({ metadata: { source: 'url', url } }));
    expect(h.fetched).toContain(url);
    expect(h.keycloak.instances.get('acme-saml')?.config.signingCertificate).toBe(VALID_CERT_B64);

    const internal = harness();
    await expect(
      internal.service.configure(
        ADMIN,
        samlInput({ metadata: { source: 'url', url: 'https://169.254.169.254/meta' } }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(internal.fetched).toHaveLength(0);
  });

  it('refuses metadata that is an XXE payload, and writes nothing', async () => {
    const h = harness();
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>`;
    await expect(
      h.service.configure(ADMIN, samlInput({ metadata: { source: 'xml', xml: xxe } })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.keycloak.writes()).toBe(0);
  });

  it('refuses metadata whose only signing certificate has expired', async () => {
    const h = harness();
    await expect(
      h.service.configure(
        ADMIN,
        samlInput({
          metadata: { source: 'xml', xml: idpMetadataXml({ certs: [EXPIRED_CERT_B64] }) },
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.keycloak.writes()).toBe(0);
  });

  it('is a no-op on a repeat with the same metadata: no provider write, audited as unchanged', async () => {
    const h = harness();
    await h.service.configure(ADMIN, samlInput());
    const writesAfterCreate = h.keycloak.writes();
    const again = await h.service.configure(ADMIN, samlInput());
    expect(again).toEqual({ alias: 'acme-saml', type: 'saml', created: false, changed: false });
    expect(h.keycloak.writes()).toBe(writesAfterCreate);
    expect(h.audit.events.at(-1)).toMatchObject({ op: 'update', outcome: 'unchanged' });
  });

  it('ignores an expired certificate left in the metadata: the configured provider is unchanged', async () => {
    const h = harness();
    await h.service.configure(ADMIN, samlInput());
    const withRetired = samlInput({
      metadata: {
        source: 'xml',
        xml: idpMetadataXml({ certs: [EXPIRED_CERT_B64, VALID_CERT_B64] }),
      },
    });
    const result = await h.service.configure(ADMIN, withRetired);
    expect(result.changed).toBe(false);
    expect(h.keycloak.instances.get('acme-saml')?.config.signingCertificate).toBe(VALID_CERT_B64);
  });
});

describe('IdentityProviderService: failures leave no half-configured provider', () => {
  it('reports a Keycloak conflict on create as KEYCLOAK_CONFLICT', async () => {
    const h = harness();
    h.keycloak.instances.set('acme-saml', {
      alias: 'acme-saml',
      providerId: 'saml',
      enabled: true,
      config: {},
    });
    await expect(h.service.configure(ADMIN, samlInput())).rejects.toMatchObject({
      code: 'KEYCLOAK_CONFLICT',
    });
  });

  it('deletes a freshly created provider when linking it to the organisation fails', async () => {
    const h = harness();
    h.keycloak.failLink = true;
    await expect(h.service.configure(ADMIN, oidcInput())).rejects.toThrow('keycloak link failed');
    expect(h.keycloak.instances.has('acme-oidc')).toBe(false);
    expect(h.audit.events).toHaveLength(0);
  });

  it('does not reuse a provider it cannot prove belongs to the organisation (alias taken)', async () => {
    const h = harness();
    h.keycloak.instances.set('acme-oidc', {
      alias: 'acme-oidc',
      providerId: 'oidc',
      enabled: true,
      config: {},
    });
    await expect(h.service.configure(ADMIN, oidcInput())).rejects.toMatchObject({
      code: 'KEYCLOAK_CONFLICT',
    });
  });
});

describe('IdentityProviderService: removal and SP metadata export', () => {
  it('unlinks and deletes a provider on the organisation and audits it', async () => {
    const h = harness();
    await h.service.configure(ADMIN, samlInput());
    const result = await h.service.remove(ADMIN, 'acme-saml');
    expect(result).toEqual({ changed: true });
    expect(h.keycloak.instances.has('acme-saml')).toBe(false);
    expect(h.keycloak.links.get(ORG_ID)?.has('acme-saml')).toBe(false);
    expect(h.audit.events.at(-1)).toMatchObject({
      action: 'auth.sso_config_changed',
      op: 'delete',
      outcome: 'applied',
    });
  });

  it('treats a removal of an absent provider as a no-op that is still audited', async () => {
    const h = harness();
    expect(await h.service.remove(ADMIN, 'acme-saml')).toEqual({ changed: false });
    expect(h.audit.events.at(-1)).toMatchObject({ op: 'delete', outcome: 'unchanged' });
  });

  it('exports the SP entityID, ACS URL and descriptor for a SAML provider on the organisation', async () => {
    const descriptor =
      'https://id.example.test/realms/blackwing/broker/acme-saml/endpoint/descriptor';
    const h = harness({ [descriptor]: () => xmlResponse(spDescriptorXml()) });
    await h.service.configure(ADMIN, samlInput());
    const exported = await h.service.exportSpMetadata(ADMIN, 'acme-saml');
    expect(exported.acsUrl).toBe(ACS_URL);
    expect(exported.entityId).toBe('https://id.example.test/realms/blackwing');
    expect(exported.metadataXml).toContain('AssertionConsumerService');
    expect(h.fetched).toContain(descriptor);
  });

  it('refuses the SP export for an OIDC provider', async () => {
    const h = harness();
    await h.service.configure(ADMIN, oidcInput());
    await expect(h.service.exportSpMetadata(ADMIN, 'acme-oidc')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('counts each applied change once in sso_idp_config_total', async () => {
    const h = harness();
    await h.service.configure(ADMIN, samlInput());
    await h.service.configure(ADMIN, samlInput());
    const counted = await h.metrics.identityProviderConfig.get();
    expect(counted.values).toEqual([{ labels: { type: 'saml', op: 'create' }, value: 1 }]);
  });
});
