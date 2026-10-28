import { z } from 'zod';

/**
 * Input schemas for the per-org identity provider API (IAM-004). Unknown fields are rejected, so an operator cannot
 * switch off a control by adding a key (for example `wantAssertionsSigned: false`, which is never accepted). Messages
 * name the field and never echo the value.
 */

/** Keycloak alias and tenant slug: lowercase letters, digits and hyphens, 1 to 63 characters. */
const IDP_ALIAS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** OpenBao KV v2 path of a client secret reference (plain path segments only). */
const SECRET_REF = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+$/;
/** An OIDC claim or SAML attribute name. */
const CLAIM_NAME = /^[A-Za-z0-9_.:/-]{1,128}$/;
/** An OAuth scope token (RFC 6749 section 3.3). */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const CLIENT_ID = /^[\x21-\x7e]{1,255}$/;

const MAX_URL = 2048;
const MAX_SCOPES = 20;
const MAX_CLOCK_SKEW_S = 300;
const DEFAULT_CLOCK_SKEW_S = 60;

const aliasSchema = z
  .string()
  .regex(IDP_ALIAS, 'must be a lowercase slug (a-z, 0-9, hyphens; 1 to 63 characters)');
const claimNameSchema = z.string().regex(CLAIM_NAME, 'must be a claim or attribute name');

/** Where the user's email, name and groups come from. Defaults match the common claim names. */
const mappersSchema = z.strictObject({
  email: claimNameSchema.default('email'),
  name: claimNameSchema.default('name'),
  groups: claimNameSchema.default('groups'),
});

const oidcSchema = z.strictObject({
  type: z.literal('oidc'),
  alias: aliasSchema,
  issuer: z.string().min(1).max(MAX_URL),
  clientId: z.string().regex(CLIENT_ID, 'must be a printable client id without spaces'),
  clientSecretRef: z.string().max(MAX_URL).regex(SECRET_REF, 'must be an OpenBao secret path'),
  scopes: z
    .array(z.string().regex(SCOPE_TOKEN, 'must be an OAuth scope token'))
    .min(1)
    .max(MAX_SCOPES)
    .refine((scopes) => scopes.includes('openid'), 'must include openid')
    .default(['openid', 'email', 'profile']),
  mappers: mappersSchema.default({ email: 'email', name: 'name', groups: 'groups' }),
});

const samlSchema = z.strictObject({
  type: z.literal('saml'),
  alias: aliasSchema,
  metadata: z.discriminatedUnion('source', [
    z.strictObject({ source: z.literal('url'), url: z.string().min(1).max(MAX_URL) }),
    z.strictObject({ source: z.literal('xml'), xml: z.string().min(1) }),
  ]),
  nameIdFormat: z.enum(['email', 'persistent']).default('email'),
  clockSkewSeconds: z.number().int().min(0).max(MAX_CLOCK_SKEW_S).default(DEFAULT_CLOCK_SKEW_S),
  mappers: mappersSchema.default({ email: 'email', name: 'name', groups: 'groups' }),
});

export const identityProviderInputSchema = z.discriminatedUnion('type', [oidcSchema, samlSchema]);
type IdentityProviderInput = z.output<typeof identityProviderInputSchema>;
export type OidcInput = Extract<IdentityProviderInput, { type: 'oidc' }>;
export type SamlInput = Extract<IdentityProviderInput, { type: 'saml' }>;

export const aliasParamSchema = aliasSchema;
