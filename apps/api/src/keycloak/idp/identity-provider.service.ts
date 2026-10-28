import { z } from 'zod';

import { AppError, ForbiddenError, NotFoundError, ValidationError } from '@blackwing/errors';

import { parseInput } from '../organizations.service.js';
import { type FetchLike, fetchBoundedText, requirePublicHttpsUrl } from './bounded-fetch.js';
import {
  aliasParamSchema,
  identityProviderInputSchema,
  type OidcInput,
  type SamlInput,
} from './inputs.js';
import { discoverOidc } from './oidc-discovery.js';
import {
  daysUntil,
  parseIdpMetadata,
  parseSpDescriptor,
  type SamlSigningCertificate,
} from './saml-metadata.js';
import { MAX_XML_BYTES } from './xml.js';

import type { KeycloakAdminClient, KeycloakAdminOp } from '../admin-client.js';
import type { KeycloakMetrics } from '../metrics.js';
import type { Principal } from '@blackwing/contracts';
import type { Logger } from '@blackwing/logger';

/**
 * Per-organisation identity providers (IAM-004): generic OIDC (discovery URL, OpenBao client-secret reference, scopes,
 * claim mappers) and SAML 2.0 (metadata by URL or XML, signing certificates, NameID format, attribute mappers). Each
 * provider is a Keycloak identity provider brokered for the tenant's Organization, so one tenant's provider never
 * serves another tenant. Every change is idempotent and audited as `auth.sso_config_changed`; only an org_admin may
 * change one (CONTEXT_PACK §8 #6, #7, #8).
 */

const ORG_ADMIN = 'org_admin';
const MANAGED_MAPPER_PREFIX = 'bw-';
const TRUE_TEXT = 'true';
const FALSE_TEXT = 'false';
const NAME_ID_FORMAT: Readonly<Record<SamlInput['nameIdFormat'], string>> = Object.freeze({
  email: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
});
const SAML_ACCEPT = 'application/samlmetadata+xml, application/xml;q=0.9, text/xml;q=0.8';

/** The caller: the canonical Principal (set by the API auth guard). The tenant alone decides the organisation. */
export type IdentityProviderPrincipal = Pick<Principal, 'subjectId' | 'tenantId' | 'roles'>;

export interface IdentityProviderAuditEvent {
  readonly action: 'auth.sso_config_changed';
  readonly outcome: 'applied' | 'unchanged';
  readonly orgId: string;
  readonly alias: string;
  readonly idpType: 'oidc' | 'saml';
  readonly op: 'create' | 'update' | 'delete';
  readonly actorSubjectId: string;
}

/** One record per configuration call, including no-ops. A rejected record propagates (an idempotent retry re-appends). */
export interface IdentityProviderAuditSink {
  record(event: IdentityProviderAuditEvent): Promise<void>;
}

export interface IdentityProviderServiceDeps {
  readonly client: KeycloakAdminClient;
  readonly audit: IdentityProviderAuditSink;
  readonly metrics: KeycloakMetrics;
  readonly logger: Logger;
  /** The Keycloak Organization of a tenant, or `undefined` when the tenant has none. Resolved from the principal only. */
  readonly organizationIdFor: (tenantId: string) => Promise<string | undefined>;
  /** Reads a client secret by OpenBao reference. The value is sent to Keycloak and never kept or logged here. */
  readonly readSecretRef: (ref: string) => Promise<string>;
  readonly fetch: FetchLike;
  /** `https://<keycloak>/realms/<realm>`, the base of the broker endpoints. */
  readonly realmUrl: string;
  readonly now: () => Date;
  readonly timeoutMs: number;
}

export interface ConfigureIdentityProviderResult {
  readonly alias: string;
  readonly type: 'oidc' | 'saml';
  readonly created: boolean;
  readonly changed: boolean;
}

export interface SpMetadataExport {
  readonly entityId: string;
  /** The assertion consumer service: the address the customer's IdP posts assertions to. */
  readonly acsUrl: string;
  /** The service-provider metadata XML, exactly as Keycloak publishes it. */
  readonly metadataXml: string;
}

interface DesiredMapper {
  readonly name: string;
  readonly identityProviderMapper: string;
  readonly config: Readonly<Record<string, string>>;
}

interface DesiredProvider {
  readonly representation: Readonly<Record<string, unknown>> & {
    readonly config: Record<string, string>;
  };
  readonly mappers: readonly DesiredMapper[];
  /** SAML only: the certificate expiry that the gauge reports. */
  readonly certificateExpiresInDays?: number;
}

const idpRepresentationSchema = z.looseObject({
  alias: z.string(),
  providerId: z.string(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.string()).optional(),
});
type IdpRepresentation = z.output<typeof idpRepresentationSchema>;

const mapperRepresentationSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  identityProviderMapper: z.string(),
  config: z.record(z.string(), z.string()).optional(),
});
type MapperRepresentation = z.output<typeof mapperRepresentationSchema>;

const linkedRepresentationSchema = z.array(z.looseObject({ alias: z.string() }));

const authorise = (principal: IdentityProviderPrincipal): void => {
  if (!principal.roles.includes(ORG_ADMIN)) {
    throw new ForbiddenError('Only an organisation administrator may manage single sign-on');
  }
};

const unexpected = (what: string): AppError =>
  new AppError('KEYCLOAK_REJECTED', `Keycloak returned an unexpected response for ${what}`, {
    detail: 'The identity provider rejected the admin request.',
  });

const notFound = (what: string): AppError =>
  new AppError('KEYCLOAK_NOT_FOUND', `Keycloak has no ${what}`, {
    detail: 'The identity-provider resource was not found.',
  });

const conflict = (what: string): AppError =>
  new AppError('KEYCLOAK_CONFLICT', `Keycloak conflict: ${what}`, {
    detail: 'The request conflicts with the current identity-provider state.',
  });

/** Whether the desired config is already present on the provider (secrets are masked, so they are not compared). */
function configMatches(
  current: IdpRepresentation,
  desired: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(desired).every(
    ([key, value]) => key === 'clientSecret' || current.config?.[key] === value,
  );
}

function mapperMatches(current: MapperRepresentation, desired: DesiredMapper): boolean {
  return (
    current.identityProviderMapper === desired.identityProviderMapper &&
    Object.entries(desired.config).every(([key, value]) => current.config?.[key] === value)
  );
}

/** The certificate that stays valid longest: during a rollover this is the successor, so logins survive the swap. */
function certificateInUse(certificates: readonly SamlSigningCertificate[]): SamlSigningCertificate {
  const first = certificates[0];
  if (first === undefined)
    throw new ValidationError('The SAML metadata has no signing certificate');
  return certificates.reduce(
    (best, candidate) => (candidate.notAfter > best.notAfter ? candidate : best),
    first,
  );
}

export class IdentityProviderService {
  private readonly deps: IdentityProviderServiceDeps;

  constructor(deps: IdentityProviderServiceDeps) {
    this.deps = deps;
  }

  /**
   * Creates or updates the identity provider for `input.alias` on the caller's organisation. A repeat with the same
   * input is a no-op for SAML. An OIDC provider is re-sent on every call, so a rotated client secret takes effect.
   * An alias that exists but belongs to another organisation is refused without revealing its configuration.
   */
  async configure(
    principal: IdentityProviderPrincipal,
    input: unknown,
  ): Promise<ConfigureIdentityProviderResult> {
    authorise(principal);
    const parsed = parseInput(identityProviderInputSchema, input);
    const orgId = await this.organizationOf(principal);
    const desired =
      parsed.type === 'oidc' ? await this.desiredOidc(parsed) : await this.desiredSaml(parsed);
    const alias = parsed.alias;

    const linked = await this.linkedAliases(orgId);
    const current = await this.getInstance(alias);
    if (current !== undefined && !linked.has(alias)) {
      throw conflict('the identity provider alias is already in use');
    }
    if (current !== undefined && current.providerId !== parsed.type) {
      throw new ValidationError('The identity provider type cannot change', {
        detail: 'delete the provider and configure it again to change its type',
      });
    }

    let created = false;
    let changed = false;
    if (current === undefined) {
      const result = await this.deps.client.request(
        'idp_create',
        'POST',
        'identity-provider/instances',
        desired.representation,
      );
      if (result.kind === 'not_found') throw notFound('realm for the identity provider');
      if (result.kind === 'conflict')
        throw conflict('the identity provider alias is already in use');
      try {
        await this.link(orgId, alias);
      } catch (error) {
        // Unlinked provider must not be left behind: a retry would see the alias as taken by another tenant.
        await this.deps.client.request(
          'idp_delete',
          'DELETE',
          `identity-provider/instances/${alias}`,
        );
        throw error;
      }
      created = true;
      changed = true;
    } else if (parsed.type === 'oidc' || !configMatches(current, desired.representation.config)) {
      const result = await this.deps.client.request(
        'idp_update',
        'PUT',
        `identity-provider/instances/${alias}`,
        desired.representation,
      );
      if (result.kind === 'not_found') throw notFound('identity provider to update');
      changed = true;
    }
    if (await this.reconcileMappers(alias, desired.mappers)) changed = true;

    if (desired.certificateExpiresInDays !== undefined) {
      this.deps.metrics.signingCertExpiryDays.set({ alias }, desired.certificateExpiresInDays);
    }
    const op = created ? 'create' : 'update';
    if (changed) this.deps.metrics.identityProviderConfig.inc({ type: parsed.type, op });
    await this.deps.audit.record({
      action: 'auth.sso_config_changed',
      outcome: changed ? 'applied' : 'unchanged',
      orgId,
      alias,
      idpType: parsed.type,
      op,
      actorSubjectId: principal.subjectId,
    });
    this.deps.logger.info(
      { alias, type: parsed.type, op, changed },
      'identity provider configured',
    );
    return { alias, type: parsed.type, created, changed };
  }

  /** Unlinks and deletes the provider. A provider that is not on the caller's organisation is a no-op. */
  async remove(
    principal: IdentityProviderPrincipal,
    aliasInput: unknown,
  ): Promise<{ readonly changed: boolean }> {
    authorise(principal);
    const alias = parseInput(aliasParamSchema, aliasInput);
    const orgId = await this.organizationOf(principal);
    const linked = await this.linkedAliases(orgId);
    let changed = false;
    if (linked.has(alias)) {
      await this.deps.client.request(
        'idp_unlink',
        'DELETE',
        `organizations/${orgId}/identity-providers/${alias}`,
      );
      const result = await this.deps.client.request(
        'idp_delete',
        'DELETE',
        `identity-provider/instances/${alias}`,
      );
      changed = result.kind === 'ok';
    }
    if (changed) this.deps.metrics.identityProviderConfig.inc({ type: 'saml', op: 'delete' });
    await this.deps.audit.record({
      action: 'auth.sso_config_changed',
      outcome: changed ? 'applied' : 'unchanged',
      orgId,
      alias,
      idpType: 'saml',
      op: 'delete',
      actorSubjectId: principal.subjectId,
    });
    return { changed };
  }

  /**
   * The service-provider metadata for a SAML provider on the caller's organisation, for the customer to register.
   * Read-only, so it is not audited.
   */
  async exportSpMetadata(
    principal: IdentityProviderPrincipal,
    aliasInput: unknown,
  ): Promise<SpMetadataExport> {
    authorise(principal);
    const alias = parseInput(aliasParamSchema, aliasInput);
    const orgId = await this.organizationOf(principal);
    const linked = await this.linkedAliases(orgId);
    const current = linked.has(alias) ? await this.getInstance(alias) : undefined;
    if (current === undefined) throw new NotFoundError('identity provider not found');
    if (current.providerId !== 'saml') {
      throw new ValidationError('The identity provider is not a SAML provider', {
        detail: 'only SAML providers have service-provider metadata',
      });
    }
    const xml = await fetchBoundedText({
      fetch: this.deps.fetch,
      url: `${this.deps.realmUrl}/broker/${alias}/endpoint/descriptor`,
      accept: 'application/xml',
      maxBytes: MAX_XML_BYTES,
      timeoutMs: this.deps.timeoutMs,
    });
    const descriptor = parseSpDescriptor(xml);
    return { entityId: descriptor.entityId, acsUrl: descriptor.acs.url, metadataXml: xml };
  }

  private async desiredOidc(input: OidcInput): Promise<DesiredProvider> {
    const discovery = await discoverOidc(input.issuer, {
      fetch: this.deps.fetch,
      timeoutMs: this.deps.timeoutMs,
    });
    const clientSecret = await this.deps.readSecretRef(input.clientSecretRef);
    const config: Record<string, string> = {
      clientId: input.clientId,
      clientSecret,
      issuer: discovery.issuer,
      authorizationUrl: discovery.authorizationEndpoint,
      tokenUrl: discovery.tokenEndpoint,
      jwksUrl: discovery.jwksUri,
      useJwksUrl: TRUE_TEXT,
      validateSignature: TRUE_TEXT,
      pkceEnabled: TRUE_TEXT,
      pkceMethod: 'S256',
      clientAuthMethod: 'client_secret_basic',
      defaultScope: input.scopes.join(' '),
      ...(discovery.userinfoEndpoint === undefined
        ? {}
        : { userInfoUrl: discovery.userinfoEndpoint }),
    };
    return {
      representation: providerRepresentation(input.alias, 'oidc', config),
      mappers: mapperSet(input.mappers, 'oidc-user-attribute-idp-mapper', 'claim'),
    };
  }

  private async desiredSaml(input: SamlInput): Promise<DesiredProvider> {
    const xml =
      input.metadata.source === 'xml'
        ? input.metadata.xml
        : await fetchBoundedText({
            fetch: this.deps.fetch,
            url: requirePublicHttpsUrl(input.metadata.url, 'The metadata URL').toString(),
            accept: SAML_ACCEPT,
            maxBytes: MAX_XML_BYTES,
            timeoutMs: this.deps.timeoutMs,
          });
    const now = this.deps.now();
    const metadata = parseIdpMetadata(xml, now);
    const certificate = certificateInUse(metadata.signingCertificates);
    const config: Record<string, string> = {
      entityId: metadata.entityId,
      singleSignOnServiceUrl: metadata.sso.url,
      postBindingAuthnRequest: String(metadata.sso.binding === 'post'),
      postBindingResponse: TRUE_TEXT,
      ...(metadata.slo === undefined
        ? {}
        : {
            singleLogoutServiceUrl: metadata.slo.url,
            postBindingLogout: String(metadata.slo.binding === 'post'),
          }),
      signingCertificate: certificate.der,
      // Assertions must be signed and their signature validated, always. There is no switch for this.
      validateSignature: TRUE_TEXT,
      wantAssertionsSigned: TRUE_TEXT,
      wantAssertionsEncrypted: FALSE_TEXT,
      wantAuthnRequestsSigned: FALSE_TEXT,
      signatureAlgorithm: 'RSA_SHA256',
      nameIDPolicyFormat: NAME_ID_FORMAT[input.nameIdFormat],
      principalType: 'SUBJECT',
      allowCreate: TRUE_TEXT,
      allowedClockSkew: String(input.clockSkewSeconds),
    };
    return {
      representation: providerRepresentation(input.alias, 'saml', config),
      mappers: mapperSet(input.mappers, 'saml-user-attribute-idp-mapper', 'attribute.name'),
      certificateExpiresInDays: daysUntil(certificate.notAfter, now),
    };
  }

  private async organizationOf(principal: IdentityProviderPrincipal): Promise<string> {
    const orgId = await this.deps.organizationIdFor(principal.tenantId);
    if (orgId === undefined)
      throw new NotFoundError('no organisation is provisioned for this tenant');
    return orgId;
  }

  private async linkedAliases(orgId: string): Promise<Set<string>> {
    const result = await this.deps.client.request(
      'idp_links',
      'GET',
      `organizations/${orgId}/identity-providers`,
    );
    if (result.kind === 'not_found') throw notFound('organisation');
    if (result.kind !== 'ok') throw unexpected('the organisation identity-provider list');
    const parsed = linkedRepresentationSchema.safeParse(result.body);
    if (!parsed.success) throw unexpected('the organisation identity-provider list');
    return new Set(parsed.data.map((entry) => entry.alias));
  }

  private async getInstance(alias: string): Promise<IdpRepresentation | undefined> {
    const result = await this.deps.client.request(
      'idp_get',
      'GET',
      `identity-provider/instances/${alias}`,
    );
    if (result.kind === 'not_found') return undefined;
    if (result.kind !== 'ok') throw unexpected('the identity-provider read');
    const parsed = idpRepresentationSchema.safeParse(result.body);
    if (!parsed.success) throw unexpected('the identity-provider read');
    return parsed.data;
  }

  private async link(orgId: string, alias: string): Promise<void> {
    const result = await this.deps.client.request(
      'idp_link',
      'POST',
      `organizations/${orgId}/identity-providers`,
      alias,
    );
    if (result.kind === 'not_found')
      throw notFound('organisation to link the identity provider to');
  }

  /** Creates, updates and removes the managed attribute mappers so they match `desired`. True when anything changed. */
  private async reconcileMappers(
    alias: string,
    desired: readonly DesiredMapper[],
  ): Promise<boolean> {
    const base = `identity-provider/instances/${alias}/mappers`;
    const listed = await this.deps.client.request('idp_mapper_list', 'GET', base);
    if (listed.kind === 'not_found') throw notFound('identity provider for its mappers');
    if (listed.kind !== 'ok') throw unexpected('the mapper list');
    const parsed = z.array(mapperRepresentationSchema).safeParse(listed.body);
    if (!parsed.success) throw unexpected('the mapper list');
    const current = parsed.data;

    let changed = false;
    for (const want of desired) {
      const existing = current.find((mapper) => mapper.name === want.name);
      if (existing === undefined) {
        await this.mapperCall('idp_mapper_create', 'POST', base, {
          name: want.name,
          identityProviderAlias: alias,
          identityProviderMapper: want.identityProviderMapper,
          config: want.config,
        });
        changed = true;
      } else if (!mapperMatches(existing, want)) {
        await this.mapperCall('idp_mapper_update', 'PUT', `${base}/${existing.id}`, {
          id: existing.id,
          name: want.name,
          identityProviderAlias: alias,
          identityProviderMapper: want.identityProviderMapper,
          config: want.config,
        });
        changed = true;
      }
    }
    const wanted = new Set(desired.map((mapper) => mapper.name));
    for (const stale of current) {
      if (stale.name.startsWith(MANAGED_MAPPER_PREFIX) && !wanted.has(stale.name)) {
        await this.mapperCall('idp_mapper_delete', 'DELETE', `${base}/${stale.id}`);
        changed = true;
      }
    }
    return changed;
  }

  private async mapperCall(
    op: KeycloakAdminOp,
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<void> {
    const result = await this.deps.client.request(op, method, path, body);
    if (result.kind === 'not_found') throw notFound('identity-provider mapper');
    if (result.kind === 'conflict') throw conflict('an identity-provider mapper name is taken');
  }
}

/** The Keycloak representation of a provider: enabled, never trusting an unverified email to link accounts. */
function providerRepresentation(
  alias: string,
  providerId: 'oidc' | 'saml',
  config: Record<string, string>,
): DesiredProvider['representation'] {
  return {
    alias,
    providerId,
    enabled: true,
    trustEmail: false,
    storeToken: false,
    linkOnly: false,
    config,
  };
}

/** Email, name and groups mappers. The managed names share one prefix so stale ones can be removed safely. */
function mapperSet(
  mappers: { readonly email: string; readonly name: string; readonly groups: string },
  mapperType: string,
  claimKey: 'claim' | 'attribute.name',
): DesiredMapper[] {
  return (
    [
      ['email', mappers.email],
      ['name', mappers.name],
      ['groups', mappers.groups],
    ] as const
  ).map(([attribute, claim]) => ({
    name: `${MANAGED_MAPPER_PREFIX}${attribute}`,
    identityProviderMapper: mapperType,
    config: {
      [claimKey]: claim,
      'user.attribute': attribute,
      syncMode: 'INHERIT',
    },
  }));
}
