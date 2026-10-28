import { z } from 'zod';

import { AppError, ValidationError } from '@blackwing/errors';

import type { KeycloakAdminClient } from './admin-client.js';
import type { Logger } from '@blackwing/logger';

/**
 * Keycloak Organizations for tenants (IAM-002). Keycloak's organisation `name` is the stable, unique key, so it
 * carries the tenant slug (`alias` here). The human-readable name is stored in the `displayName` attribute.
 * Every operation is idempotent, so a retry after a partial failure completes the work (see the issue's edge cases).
 */

/** Tenant slug: lowercase letters, digits and hyphens, 1 to 63 characters, no leading or trailing hyphen. */
const ALIAS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_ORGANIZATION_DOMAINS = 20;
const MAX_DISPLAY_NAME = 200;

const aliasSchema = z
  .string()
  .regex(ALIAS, 'must be a lowercase slug (a-z, 0-9, hyphens; 1 to 63 characters)');
const displayNameSchema = z.string().trim().min(1).max(MAX_DISPLAY_NAME);
const domainsSchema = z
  .array(z.string().trim().toLowerCase().regex(DOMAIN, 'must be a domain name'))
  .max(MAX_ORGANIZATION_DOMAINS)
  .transform((list) => [...new Set(list)]);
const uuidSchema = z.string().regex(UUID, 'must be a UUID');

const createInputSchema = z.strictObject({
  alias: aliasSchema,
  name: displayNameSchema,
  domains: domainsSchema.default([]),
});
const updateInputSchema = z
  .strictObject({ displayName: displayNameSchema.optional(), domains: domainsSchema.optional() })
  .refine((value) => value.displayName !== undefined || value.domains !== undefined, {
    message: 'must change displayName or domains',
  });

/** The Keycloak organisation representation. Unknown fields are kept so a PUT does not drop them. */
const representationSchema = z.looseObject({
  id: uuidSchema,
  name: z.string(),
  attributes: z.record(z.string(), z.array(z.string())).optional(),
  domains: z
    .array(z.looseObject({ name: z.string(), verified: z.boolean().optional() }))
    .optional(),
});
type Representation = z.output<typeof representationSchema>;

export interface KeycloakOrganization {
  readonly id: string;
  readonly alias: string;
  readonly displayName: string;
  readonly domains: readonly string[];
}

export interface CreateOrganizationResult {
  readonly organization: KeycloakOrganization;
  /** False when the organisation already existed (the call was a no-op). */
  readonly created: boolean;
}

/** One audit record per mutating call, including the no-op ones (IAM-012 wires the ledger behind this port). */
export interface OrganizationAuditEvent {
  readonly action:
    | 'organization.create'
    | 'organization.update'
    | 'organization.delete'
    | 'organization.member_add'
    | 'organization.member_remove';
  readonly outcome: 'applied' | 'unchanged';
  readonly orgId: string;
  readonly alias?: string;
  readonly userId?: string;
}

export interface OrganizationAuditSink {
  /** A rejection propagates: the mutation is already applied, and an idempotent retry appends the record. */
  record(event: OrganizationAuditEvent): Promise<void>;
}

export interface OrganizationsServiceDeps {
  readonly client: KeycloakAdminClient;
  readonly audit: OrganizationAuditSink;
  readonly logger: Logger;
}

/** Validates external input with the schema; the message names the fields and never echoes values. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`)
    .join('; ');
  throw new ValidationError('Invalid organisation request', { detail: fields });
}

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

function parseRepresentation(body: unknown, what: string): Representation {
  const parsed = representationSchema.safeParse(body);
  if (!parsed.success) throw unexpected(what);
  return parsed.data;
}

function toOrganization(rep: Representation): KeycloakOrganization {
  return {
    id: rep.id,
    alias: rep.name,
    displayName: rep.attributes?.displayName?.[0] ?? rep.name,
    domains: (rep.domains ?? []).map((domain) => domain.name),
  };
}

/** The new representation: the patch applied over the current one. Domains keep their verified flag by name. */
function applyPatch(
  current: Representation,
  patch: {
    readonly displayName?: string | undefined;
    readonly domains?: readonly string[] | undefined;
  },
): Representation {
  const currentOrg = toOrganization(current);
  const currentDomains = current.domains ?? [];
  return {
    ...current,
    attributes: {
      ...current.attributes,
      displayName: [patch.displayName ?? currentOrg.displayName],
    },
    ...(patch.domains === undefined
      ? {}
      : {
          domains: patch.domains.map((name) => ({
            name,
            verified: currentDomains.find((domain) => domain.name === name)?.verified ?? false,
          })),
        }),
  };
}

const sameDomains = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** The organisation id from a `Location` header (`.../organizations/<uuid>`). Keycloak always sends it on a 201. */
function idFromLocation(location: string | undefined): string {
  const id = location?.split('/').pop() ?? '';
  if (!UUID.test(id)) throw unexpected('the organisation create');
  return id;
}

export class OrganizationsService {
  private readonly deps: OrganizationsServiceDeps;

  constructor(deps: OrganizationsServiceDeps) {
    this.deps = deps;
  }

  /**
   * Creates the organisation for `alias`, or returns the existing one. A second call with the same alias is a
   * no-op. A concurrent create that loses the race (Keycloak answers 409) reads the winner back.
   */
  async createOrganization(input: unknown): Promise<CreateOrganizationResult> {
    const { alias, name, domains } = parseInput(createInputSchema, input);
    const existing = await this.findByAlias(alias);
    if (existing !== undefined) return this.reuse(existing);

    const result = await this.deps.client.request('create', 'POST', 'organizations', {
      name: alias,
      attributes: { displayName: [name] },
      domains: domains.map((domain) => ({ name: domain, verified: false })),
    });
    if (result.kind === 'not_found') throw notFound('realm for the organisation create');
    if (result.kind === 'conflict') {
      const raced = await this.findByAlias(alias);
      if (raced === undefined) throw conflict('the organisation name is taken by another object');
      return this.reuse(raced);
    }

    const orgId = idFromLocation(result.location);
    await this.deps.audit.record({
      action: 'organization.create',
      outcome: 'applied',
      orgId,
      alias,
    });
    this.deps.logger.info({ orgId, alias }, 'keycloak organisation created');
    return {
      organization: { id: orgId, alias, displayName: name, domains },
      created: true,
    };
  }

  /** The organisation whose tenant slug is `alias`, or `undefined`. */
  async getByAlias(alias: string): Promise<KeycloakOrganization | undefined> {
    return this.findByAlias(parseInput(aliasSchema, alias));
  }

  /** Updates the display name and/or the domains. Re-applying the same values is a no-op (no PUT). */
  async update(orgId: string, input: unknown): Promise<KeycloakOrganization> {
    const id = parseInput(uuidSchema, orgId);
    const patch = parseInput(updateInputSchema, input);
    const current = await this.getRepresentation(id);
    const next = applyPatch(current, patch);
    const before = toOrganization(current);
    const after = toOrganization(next);
    const unchanged =
      before.displayName === after.displayName && sameDomains(before.domains, after.domains);
    if (!unchanged) {
      const result = await this.deps.client.request('update', 'PUT', `organizations/${id}`, next);
      if (result.kind === 'not_found') throw notFound('organisation to update');
      if (result.kind === 'conflict') throw conflict('an organisation domain is already claimed');
    }
    await this.deps.audit.record({
      action: 'organization.update',
      outcome: unchanged ? 'unchanged' : 'applied',
      orgId: id,
    });
    return after;
  }

  /** Deletes the organisation. A missing one is already deleted (`changed: false`). */
  async delete(orgId: string): Promise<{ readonly changed: boolean }> {
    const id = parseInput(uuidSchema, orgId);
    const result = await this.deps.client.request('delete', 'DELETE', `organizations/${id}`);
    if (result.kind === 'conflict') throw conflict('the organisation cannot be deleted');
    const changed = result.kind === 'ok';
    await this.deps.audit.record({
      action: 'organization.delete',
      outcome: changed ? 'applied' : 'unchanged',
      orgId: id,
    });
    return { changed };
  }

  /** Adds a user to the organisation. Already a member (Keycloak 409) is a no-op. */
  async addMember(orgId: string, userId: string): Promise<{ readonly changed: boolean }> {
    const id = parseInput(uuidSchema, orgId);
    const user = parseInput(uuidSchema, userId);
    const result = await this.deps.client.request(
      'add_member',
      'POST',
      `organizations/${id}/members`,
      user,
    );
    if (result.kind === 'not_found') throw notFound('organisation or user to add as a member');
    const changed = result.kind === 'ok';
    await this.deps.audit.record({
      action: 'organization.member_add',
      outcome: changed ? 'applied' : 'unchanged',
      orgId: id,
      userId: user,
    });
    return { changed };
  }

  /** Removes a user from the organisation. A user who is not a member is a no-op. */
  async removeMember(orgId: string, userId: string): Promise<{ readonly changed: boolean }> {
    const id = parseInput(uuidSchema, orgId);
    const user = parseInput(uuidSchema, userId);
    const result = await this.deps.client.request(
      'remove_member',
      'DELETE',
      `organizations/${id}/members/${user}`,
    );
    if (result.kind === 'conflict') throw conflict('the member cannot be removed');
    const changed = result.kind === 'ok';
    await this.deps.audit.record({
      action: 'organization.member_remove',
      outcome: changed ? 'applied' : 'unchanged',
      orgId: id,
      userId: user,
    });
    return { changed };
  }

  private async reuse(existing: KeycloakOrganization): Promise<CreateOrganizationResult> {
    await this.deps.audit.record({
      action: 'organization.create',
      outcome: 'unchanged',
      orgId: existing.id,
      alias: existing.alias,
    });
    return { organization: existing, created: false };
  }

  /** Exact match on the stored name; Keycloak's search may be fuzzy on older releases, so the match is checked here. */
  private async findByAlias(alias: string): Promise<KeycloakOrganization | undefined> {
    const query = new URLSearchParams({ search: alias, exact: 'true', first: '0', max: '10' });
    const result = await this.deps.client.request(
      'list',
      'GET',
      `organizations?${query.toString()}`,
    );
    if (result.kind !== 'ok') throw unexpected('the organisation lookup');
    const parsed = z.array(representationSchema).safeParse(result.body);
    if (!parsed.success) throw unexpected('the organisation lookup');
    const match = parsed.data.find((rep) => rep.name === alias);
    return match === undefined ? undefined : toOrganization(match);
  }

  private async getRepresentation(orgId: string): Promise<Representation> {
    const result = await this.deps.client.request('get', 'GET', `organizations/${orgId}`);
    if (result.kind === 'not_found') throw notFound('organisation');
    if (result.kind === 'conflict') throw unexpected('the organisation read');
    return parseRepresentation(result.body, 'the organisation read');
  }
}
