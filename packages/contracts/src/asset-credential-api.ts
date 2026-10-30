import { z } from 'zod';

import { ASSET_JSON_MAX_BYTES, MFA_TYPES, type MfaType, mfaTypeSchema } from './entities/asset.js';
import { LIMITS } from './limits.js';
import { isoDateTimeSchema, uuidV7Schema } from './primitives.js';
import { formatSecretRef } from './secrets.js';

/**
 * The asset credential REST contract (ASSET-011-adjacent, #363): per-role logins of an asset. The secret values
 * travel in the request body once, straight to the Secrets Service; the stored shapes and the views carry only the
 * opaque `secretRef` and the non-secret login recipe (§8.7). No schema here ever returns a secret value.
 */

/** Largest serialised login recipe a credential may carry: the `asset_credentials.login_recipe` cap (§7). */
export const ASSET_CREDENTIAL_RECIPE_MAX_BYTES = ASSET_JSON_MAX_BYTES;

/** The last C0 control character; DEL (0x7f) is refused as well. */
const CONTROL_MAX = 0x1f;
const DEL = 0x7f;

/** A selector, field name or script reference: printable, no whitespace, bounded. */
const recipeTokenSchema = z
  .string()
  .min(1)
  .max(LIMITS.urlMax)
  .refine(
    (value) =>
      !/\s/u.test(value) &&
      Array.from(value).every((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code > CONTROL_MAX && code !== DEL;
      }),
    'must not contain whitespace or control characters',
  );

/** An `http(s)` URL that carries no userinfo: a credential embedded in a URL would be stored in plaintext. */
const loginUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(LIMITS.urlMax)
  .refine((value) => {
    const url = new URL(value);
    return url.username === '' && url.password === '';
  }, 'must not carry credentials in the URL');

/** `form`: a browser login form. The field and button selectors are not secrets (values come from the secrets). */
const formLoginRecipeSchema = z.strictObject({
  type: z.literal('form'),
  loginUrl: loginUrlSchema,
  usernameField: recipeTokenSchema,
  passwordField: recipeTokenSchema,
  submitSelector: recipeTokenSchema,
  successCheck: recipeTokenSchema,
});

/** `http_basic`: HTTP Basic authentication; the username and password are the role's secrets. */
const httpBasicLoginRecipeSchema = z.strictObject({ type: z.literal('http_basic') });

/** `bearer_header`: the role's token is sent in the named header. */
const bearerHeaderLoginRecipeSchema = z.strictObject({
  type: z.literal('bearer_header'),
  headerName: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/, 'must be an HTTP header name')
    .transform((name) => name.toLowerCase()),
});

/** `oauth_password`: the resource-owner password grant against a token endpoint. */
const oauthPasswordLoginRecipeSchema = z.strictObject({
  type: z.literal('oauth_password'),
  tokenUrl: loginUrlSchema,
  clientRef: recipeTokenSchema,
});

/** `custom_script`: a reviewed login script, referenced by name. */
const customScriptLoginRecipeSchema = z.strictObject({
  type: z.literal('custom_script'),
  scriptRef: recipeTokenSchema,
});

/** The login recipe of a role, discriminated by `type`. Unknown types and unknown keys are refused. */
export const assetLoginRecipeSchema = z.discriminatedUnion('type', [
  formLoginRecipeSchema,
  httpBasicLoginRecipeSchema,
  bearerHeaderLoginRecipeSchema,
  oauthPasswordLoginRecipeSchema,
  customScriptLoginRecipeSchema,
]);
export type AssetLoginRecipe = z.infer<typeof assetLoginRecipeSchema>;

const SECRET_USERNAME_MAX = 256;
const SECRET_PASSWORD_MAX = 4096;
const SECRET_TOKEN_MAX = 8192;
const SECRET_TOTP_SEED_MAX = 1024;

/**
 * The secret material of one role. It is accepted once, forwarded to the Secrets Service and never echoed back.
 * Values are not trimmed: a password's whitespace is part of it.
 */
export const assetCredentialSecretsSchema = z.strictObject({
  username: z.string().min(1).max(SECRET_USERNAME_MAX).optional(),
  password: z.string().min(1).max(SECRET_PASSWORD_MAX).optional(),
  token: z.string().min(1).max(SECRET_TOKEN_MAX).optional(),
  totpSeed: z.string().min(1).max(SECRET_TOTP_SEED_MAX).optional(),
});
export type AssetCredentialSecrets = z.infer<typeof assetCredentialSecretsSchema>;

/**
 * The secrets a recipe and an MFA type need (checked after the body parses): form, HTTP Basic and OAuth password
 * need a username and a password, a bearer header needs a token, and TOTP needs its seed. Returns the missing
 * field names; an empty list is a complete set.
 */
export function missingCredentialSecrets(
  recipe: AssetLoginRecipe,
  mfaType: MfaType,
  secrets: AssetCredentialSecrets,
): string[] {
  const missing: string[] = [];
  if (recipe.type === 'form' || recipe.type === 'http_basic' || recipe.type === 'oauth_password') {
    if (secrets.username === undefined) missing.push('secrets.username');
    if (secrets.password === undefined) missing.push('secrets.password');
  }
  if (recipe.type === 'bearer_header' && secrets.token === undefined) {
    missing.push('secrets.token');
  }
  if (mfaType === 'totp' && secrets.totpSeed === undefined) missing.push('secrets.totpSeed');
  return missing;
}

/**
 * `POST /v1/assets/{id}/credentials` body. `mfaType` defaults to `none`. The role name is unique per asset.
 */
export const createAssetCredentialBodySchema = z.strictObject({
  roleName: z.string().trim().min(1).max(LIMITS.shortTextMax),
  loginRecipe: assetLoginRecipeSchema,
  mfaType: mfaTypeSchema.default('none'),
  secrets: assetCredentialSecretsSchema,
});
export type CreateAssetCredentialBody = z.infer<typeof createAssetCredentialBodySchema>;

/** `POST /v1/assets/{id}/credentials/{role}/rotate` body: the complete replacement secret set of the role. */
export const rotateAssetCredentialBodySchema = z.strictObject({
  secrets: assetCredentialSecretsSchema,
});
export type RotateAssetCredentialBody = z.infer<typeof rotateAssetCredentialBodySchema>;

/** A credential as the API returns it: the recipe and the reference only, never a secret value (§8.7). */
export const assetCredentialViewSchema = z.strictObject({
  id: uuidV7Schema,
  roleName: z.string().min(1).max(LIMITS.shortTextMax),
  loginRecipe: assetLoginRecipeSchema,
  mfaType: z.enum(MFA_TYPES),
  secretRef: z.string().regex(/^bw-secret:\/\/[^/\s]+\/[^/\s]+$/),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type AssetCredentialView = z.infer<typeof assetCredentialViewSchema>;

/** The list answer: every credential of the asset, by role name. */
export const assetCredentialListResponseSchema = z.strictObject({
  items: z.array(assetCredentialViewSchema),
});
export type AssetCredentialListResponse = z.infer<typeof assetCredentialListResponseSchema>;

/** The answer of a rotation: the role's reference and the version the Secrets Service now serves. */
export const assetCredentialRotationViewSchema = z.strictObject({
  roleName: z.string().min(1).max(LIMITS.shortTextMax),
  secretRef: z.string().regex(/^bw-secret:\/\/[^/\s]+\/[^/\s]+$/),
  secretVersion: z.number().int().min(1),
  rotatedAt: isoDateTimeSchema,
});
export type AssetCredentialRotationView = z.infer<typeof assetCredentialRotationViewSchema>;

/** The `secret_ref` of a credential secret: the tenant and the secret record (SECRETS-003). */
export function credentialSecretRef(tenantId: string, secretId: string): string {
  return formatSecretRef({ tenantId, secretId });
}
