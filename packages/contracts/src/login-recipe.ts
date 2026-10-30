import { z } from 'zod';

import { isoDateTimeSchema, uuidV7Schema } from './primitives.js';
import { parseSecretRef, SecretRefError } from './secrets.js';
import { ROLE_ID_PATTERN, roleIdSchema } from './session-roles.js';

/**
 * Login recipes and credential references for the session manager (SESSION-002, #613; CONTEXT_PACK S7, S8.7).
 *
 * A recipe is declarative: it says how a role logs in and how to tell the session is still valid, and it names
 * every secret by reference (`bw-secret://...`, see secrets.ts). It never carries a secret value. The schema is
 * the guardrail: unknown keys are refused by strict objects, and a walk over the raw input refuses any
 * secret-shaped key with the stable code `SM_RECIPE_INVALID`, before the recipe shape is even checked.
 */

/** Size and range limits for recipe fields. Named so the bounds are reviewable in one place. */
const URL_MAX_LENGTH = 2048;
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const SELECTOR_MAX_LENGTH = 512;
const VALUE_MAX_LENGTH = 1024;
const SCOPE_MAX_LENGTH = 128;
const SCOPES_MAX = 64;
const CLIENT_ID_MAX_LENGTH = 256;
const HEADER_NAME_MAX_LENGTH = 128;
const COOKIE_NAME_MAX_LENGTH = 256;
const FORM_STEPS_MAX = 64;
const COOKIES_MAX = 128;
const ROLE_MATRIX_KEY_MAX_LENGTH = 128;

/** Stable error code for a recipe that tries to carry secret material. */
export const SM_RECIPE_INVALID = 'SM_RECIPE_INVALID';

/** Recipe kinds (the discriminator of {@link loginRecipeSchema}). */
export const LOGIN_RECIPE_KINDS = Object.freeze([
  'form',
  'oidc_auth_code',
  'oauth2_client_credentials',
  'static_header',
  'cookie_import',
] as const);
export const loginRecipeKindSchema = z.enum(LOGIN_RECIPE_KINDS);
export type LoginRecipeKind = z.infer<typeof loginRecipeKindSchema>;

/**
 * The credential reference every secret-bearing field uses: `{ secretRef }` holding a `bw-secret://` URI. The value
 * stays the canonical string, so a stored recipe round-trips through JSON unchanged.
 */
export const credentialRefSchema = z.strictObject({
  secretRef: z.string().superRefine((value, ctx) => {
    try {
      parseSecretRef(value);
    } catch (error) {
      if (!(error instanceof SecretRefError)) throw error;
      ctx.addIssue({
        code: 'custom',
        message: 'must be a bw-secret://{tenantId}/{secretId}[?v=N] URI',
      });
    }
  }),
});
export type CredentialRef = z.infer<typeof credentialRefSchema>;

/** Keys whose value would be a literal secret. Compared case-insensitively at every depth of the raw input. */
const FORBIDDEN_SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pass',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'secret',
  'clientsecret',
  'apikey',
  'bearer',
  'cookievalue',
  'plaintext',
  'privatekey',
]);

/** Returns the first secret-shaped key found anywhere in `value`, or undefined. Pure; bounded by input size. */
export function findForbiddenSecretKey(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenSecretKey(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  // A `{ name, value }` pair is a cookie with a literal value; `value` is plain text in other places (form steps).
  const isNamedPair = 'name' in value;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase()) || (isNamedPair && key === 'value'))
      return key;
    const found = findForbiddenSecretKey(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

const LITERAL_SECRET_MESSAGE =
  'a recipe may not carry secret material; reference it with a credentialRef';

/** A URL the recipe may call. HTTP(S) only, so a recipe cannot point at `file:` or other schemes. */
const httpUrlSchema = z
  .string()
  .max(URL_MAX_LENGTH)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'must be an absolute http(s) URL' },
  );

/**
 * A declarative post-login validity assertion. A canary (SESSION-009) replays it to decide whether a session is
 * still live. It must assert at least one thing, so an empty check cannot pass everything.
 */
export const successCheckSchema = z
  .strictObject({
    url: httpUrlSchema,
    expectedStatus: z.int().min(HTTP_STATUS_MIN).max(HTTP_STATUS_MAX).optional(),
    selector: z.string().min(1).max(SELECTOR_MAX_LENGTH).optional(),
    jsonPath: z
      .strictObject({
        path: z.string().min(1).max(SELECTOR_MAX_LENGTH),
        equals: z.union([z.string().max(VALUE_MAX_LENGTH), z.number(), z.boolean(), z.null()]),
      })
      .optional(),
  })
  .refine(
    (check) =>
      check.expectedStatus !== undefined ||
      check.selector !== undefined ||
      check.jsonPath !== undefined,
    { message: 'a success check must assert a status, a selector or a JSON path' },
  );
export type SuccessCheck = z.infer<typeof successCheckSchema>;

/** MFA for a role. TOTP needs the secret ref of the seed; `none` must not carry one. */
export const mfaSchema = z
  .strictObject({
    type: z.enum(['totp', 'none']),
    secretRef: credentialRefSchema.optional(),
  })
  .superRefine((mfa, ctx) => {
    if (mfa.type === 'totp' && mfa.secretRef === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'totp MFA requires a secretRef',
        path: ['secretRef'],
      });
    }
    if (mfa.type === 'none' && mfa.secretRef !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'MFA type none must not carry a secretRef',
        path: ['secretRef'],
      });
    }
  });
export type Mfa = z.infer<typeof mfaSchema>;

const selectorSchema = z.string().min(1).max(SELECTOR_MAX_LENGTH);

/** One step of a form login. `fill_text` is non-secret text; anything secret goes through `fill_secret`. */
export const formStepSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('fill_text'),
    selector: selectorSchema,
    value: z.string().max(VALUE_MAX_LENGTH),
  }),
  z.strictObject({
    action: z.literal('fill_secret'),
    selector: selectorSchema,
    credentialRef: credentialRefSchema,
  }),
  z.strictObject({ action: z.literal('click'), selector: selectorSchema }),
]);
export type FormStep = z.infer<typeof formStepSchema>;

const scopesSchema = z.array(z.string().min(1).max(SCOPE_MAX_LENGTH)).max(SCOPES_MAX);
const clientIdSchema = z.string().min(1).max(CLIENT_ID_MAX_LENGTH);
const headerNameSchema = z
  .string()
  .min(1)
  .max(HEADER_NAME_MAX_LENGTH)
  .regex(/^[A-Za-z0-9-]+$/, 'must be an HTTP header name');
const cookieNameSchema = z
  .string()
  .min(1)
  .max(COOKIE_NAME_MAX_LENGTH)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'must be an RFC 6265 cookie name');

const cookieRefSchema = z.strictObject({
  name: cookieNameSchema,
  credentialRef: credentialRefSchema,
});

/** Fields every recipe kind carries. */
const recipeBaseShape = {
  roleName: roleIdSchema,
  mfa: mfaSchema.optional(),
  successCheck: successCheckSchema,
};

export const formRecipeSchema = z.strictObject({
  ...recipeBaseShape,
  kind: z.literal('form'),
  loginUrl: httpUrlSchema,
  steps: z.array(formStepSchema).min(1).max(FORM_STEPS_MAX),
  credentialRef: credentialRefSchema,
});

export const oidcAuthCodeRecipeSchema = z.strictObject({
  ...recipeBaseShape,
  kind: z.literal('oidc_auth_code'),
  issuer: httpUrlSchema,
  clientId: clientIdSchema,
  redirectUri: httpUrlSchema,
  scopes: scopesSchema.min(1),
  credentialRef: credentialRefSchema,
});

export const oauth2ClientCredentialsRecipeSchema = z.strictObject({
  ...recipeBaseShape,
  kind: z.literal('oauth2_client_credentials'),
  tokenUrl: httpUrlSchema,
  clientIdRef: credentialRefSchema,
  clientSecretRef: credentialRefSchema,
  scopes: scopesSchema,
});

export const staticHeaderRecipeSchema = z.strictObject({
  ...recipeBaseShape,
  kind: z.literal('static_header'),
  headerName: headerNameSchema,
  scheme: z.enum(['bearer', 'basic', 'apikey']),
  credentialRef: credentialRefSchema,
});

export const cookieImportRecipeSchema = z
  .strictObject({
    ...recipeBaseShape,
    kind: z.literal('cookie_import'),
    cookies: z.array(cookieRefSchema).min(1).max(COOKIES_MAX),
  })
  .superRefine((recipe, ctx) => {
    const seen = new Set<string>();
    for (const [index, cookie] of recipe.cookies.entries()) {
      if (seen.has(cookie.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate cookie name "${cookie.name}"`,
          path: ['cookies', index, 'name'],
        });
      }
      seen.add(cookie.name);
    }
  });

/**
 * A login recipe, a discriminated union over `kind`. The literal-secret guard runs first: a recipe that carries a
 * secret-shaped key is refused as `SM_RECIPE_INVALID` before its shape is checked.
 */
const loginRecipeUnion = z.discriminatedUnion('kind', [
  formRecipeSchema,
  oidcAuthCodeRecipeSchema,
  oauth2ClientCredentialsRecipeSchema,
  staticHeaderRecipeSchema,
  cookieImportRecipeSchema,
]);
const literalSecretGuard = z.unknown().superRefine((value, ctx) => {
  const key = findForbiddenSecretKey(value);
  if (key !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `${SM_RECIPE_INVALID}: field "${key}" holds secret material; ${LITERAL_SECRET_MESSAGE}`,
      params: { code: SM_RECIPE_INVALID },
    });
  }
});
export const loginRecipeSchema = literalSecretGuard.pipe(loginRecipeUnion);
export type LoginRecipe = z.infer<typeof loginRecipeSchema>;

/**
 * The non-secret metadata of a live role session. It names the session and when it lapses; it never carries a
 * token, cookie or secret.
 */
export const roleSessionDescriptorSchema = z.strictObject({
  tenantId: uuidV7Schema,
  runId: uuidV7Schema,
  assetId: uuidV7Schema,
  roleName: roleIdSchema,
  kind: loginRecipeKindSchema,
  expiresAt: isoDateTimeSchema,
});
export type RoleSessionDescriptor = z.infer<typeof roleSessionDescriptorSchema>;

/**
 * Reference shape of a role matrix (F9): for each role, the access it has to each named function. Roles use the
 * same slug as the session tools (`ROLE_ID_PATTERN`).
 */
export const ROLE_MATRIX_ACCESS = Object.freeze(['allow', 'deny'] as const);
export const roleMatrixAccessSchema = z.enum(ROLE_MATRIX_ACCESS);
export const roleMatrixSchema = z.record(
  z.string().regex(ROLE_ID_PATTERN),
  z.record(z.string().min(1).max(ROLE_MATRIX_KEY_MAX_LENGTH), roleMatrixAccessSchema),
);
export type RoleMatrix = z.infer<typeof roleMatrixSchema>;
