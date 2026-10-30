import { z } from 'zod';

import { isoDateTimeSchema, uuidV7Schema } from './primitives.js';

/**
 * Secret records and the opaque `secret_ref` URI (SECRETS-003, F35, CONTEXT_PACK §7, §8.6, §8.7).
 *
 * Nothing stores a plaintext credential: every table that needs one holds a `secret_ref`, an
 * identifier that is safe to store and log. Consumers never read the `secrets` table; they resolve a
 * reference through the Secrets Service (SECRETS-006), which is what lets external backends work the
 * same way. The value lists below are the single source for the `secrets` check constraints in
 * `@blackwing/db`.
 */

/** What kind of credential a secret holds. Optional on a record. */
export const SECRET_TYPES = [
  'password',
  'api_key',
  'token',
  'certificate',
  'ssh_key',
  'webhook_secret',
  'kms_ref',
  'generic',
] as const;
export const secretTypeSchema = z.enum(SECRET_TYPES);
export type SecretType = z.infer<typeof secretTypeSchema>;

/** Where the secret value lives. `openbao` is Blackwing-managed; the rest are customer-owned (BYOK). */
export const SECRET_BACKENDS = [
  'openbao',
  'aws_kms',
  'vault',
  'aws_secrets_manager',
  'azure_kv',
] as const;
export const secretBackendSchema = z.enum(SECRET_BACKENDS);
export type SecretBackend = z.infer<typeof secretBackendSchema>;

/** Backends whose value lives outside Blackwing: a record on one must carry an `external_locator`. */
export const EXTERNAL_SECRET_BACKENDS = [
  'aws_kms',
  'vault',
  'aws_secrets_manager',
  'azure_kv',
] as const satisfies readonly SecretBackend[];

/** Lifecycle of a secret. `shredded` is terminal: the value is gone and resolving it fails. */
export const SECRET_STATUSES = ['active', 'rotating', 'disabled', 'shredded'] as const;
export const secretStatusSchema = z.enum(SECRET_STATUSES);
export type SecretStatus = z.infer<typeof secretStatusSchema>;

/** Longest secret `name`, in characters. */
export const SECRET_NAME_MAX = 255;

/**
 * A secret's display name: NFC-normalised (so canonically equal spellings collide on the unique
 * `(tenant_id, name)`), 1 to {@link SECRET_NAME_MAX} characters, no control characters.
 */
export const secretNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC'))
  .pipe(
    z
      .string()
      .min(1)
      .max(SECRET_NAME_MAX)
      .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), {
        message: 'must not contain control characters',
      }),
  );

/** URI scheme of a `secret_ref`. */
export const SECRET_REF_SCHEME = 'bw-secret:';

/** Stable machine code of every `secret_ref` failure; registered in `@blackwing/errors`. */
export const SECRET_REF_ERROR_CODE = 'INVALID_SECRET_REF';

/** Thrown for a malformed `secret_ref`. The message never echoes the input (it may be attacker text). */
export class SecretRefError extends Error {
  readonly code = SECRET_REF_ERROR_CODE;

  constructor(reason: string) {
    super(`Invalid secret_ref: ${reason}`);
    this.name = 'SecretRefError';
  }
}

/** True when `value` is a `SecretRefError` (also across package copies). */
export function isSecretRefError(value: unknown): value is SecretRefError {
  return (
    value instanceof Error &&
    value.name === 'SecretRefError' &&
    (value as { code?: unknown }).code === SECRET_REF_ERROR_CODE
  );
}

/** An id segment of a ref: tenant and secret ids (UUIDs in practice); the grammar stays tenant-agnostic. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Highest version a ref may pin (Postgres `integer`). */
const VERSION_MAX = 2_147_483_647;

/** A parsed `secret_ref`. `version` is absent when the ref follows the secret's `current_version`. */
export interface SecretRef {
  readonly tenantId: string;
  readonly secretId: string;
  readonly version?: number;
}

/**
 * Parses `bw-secret://{tenantId}/{secretId}[?v={version}]`. Pure and tenant-agnostic: whether the ref
 * belongs to the caller's tenant is the resolver's check (SECRETS-006), not the parser's. Throws
 * {@link SecretRefError} (`INVALID_SECRET_REF`) for anything else, including extra path segments,
 * other query parameters, a fragment, credentials, a port or a non-canonical version.
 */
export function parseSecretRef(value: unknown): SecretRef {
  if (typeof value !== 'string') throw new SecretRefError('not a string');
  const prefix = `${SECRET_REF_SCHEME}//`;
  if (!value.startsWith(prefix)) throw new SecretRefError('wrong scheme');
  const [path = '', ...queryParts] = value.slice(prefix.length).split('?');
  if (queryParts.length > 1) throw new SecretRefError('malformed query');
  const segments = path.split('/');
  const [tenantId = '', secretId = ''] = segments;
  if (segments.length !== 2 || !SEGMENT.test(tenantId) || !SEGMENT.test(secretId)) {
    throw new SecretRefError('expected {tenantId}/{secretId}');
  }
  const ref = { tenantId, secretId };
  const query = queryParts[0];
  if (query === undefined) return ref;
  const match = /^v=([1-9][0-9]{0,9})$/.exec(query);
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version > VERSION_MAX) {
    throw new SecretRefError('version must be a positive integer');
  }
  return { ...ref, version };
}

/** Builds the canonical `secret_ref`; validates through {@link parseSecretRef} so the two always agree. */
export function formatSecretRef(ref: SecretRef): string {
  const base = `${SECRET_REF_SCHEME}//${ref.tenantId}/${ref.secretId}`;
  const formatted = ref.version === undefined ? base : `${base}?v=${String(ref.version)}`;
  parseSecretRef(formatted);
  return formatted;
}

/** Zod form of {@link parseSecretRef} for request bodies and config: parses to a {@link SecretRef}. */
export const secretRefSchema = z.string().transform((value, ctx): SecretRef => {
  try {
    return parseSecretRef(value);
  } catch {
    ctx.addIssue({
      code: 'custom',
      message: 'must be a bw-secret://{tenantId}/{secretId}[?v=N] URI',
    });
    return z.NEVER;
  }
});

/** The version a ref resolves to: its pinned `v`, else the secret's `current_version`. */
export function resolveSecretVersion(ref: SecretRef, currentVersion: number): number {
  return ref.version ?? currentVersion;
}

/** Largest secret value the write API accepts, in UTF-8 bytes (certificates and SSH keys fit well below). */
export const SECRET_VALUE_MAX_BYTES = 65_536;

/** Longest `purpose` label, in characters. */
export const SECRET_PURPOSE_MAX = 500;

/**
 * A secret value as submitted: non-empty, well-formed Unicode and no NUL. Nothing is trimmed or
 * normalised (a credential is stored exactly as given). The byte limit is checked by the API so an
 * oversized value answers `413 SECRET_TOO_LARGE` rather than a validation error.
 */
export const secretValueSchema = z
  .string()
  .min(1)
  // With the `u` flag a paired surrogate is one code point, so `\p{Surrogate}` matches a lone one only.
  .refine((value) => !/\p{Surrogate}/u.test(value) && !value.includes('\u0000'), {
    message: 'must be well-formed text without NUL characters',
  });

/** `POST /v1/secrets` body (SECRETS-004). Unknown members are rejected: no `envelope`, no `status`. */
export const createSecretRequestSchema = z.strictObject({
  name: secretNameSchema,
  type: secretTypeSchema.optional(),
  purpose: z
    .string()
    .min(1)
    .max(SECRET_PURPOSE_MAX)
    .refine((value) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), {
      message: 'must not contain control characters',
    })
    .optional(),
  value: secretValueSchema,
  backend: secretBackendSchema.optional(),
});
export type CreateSecretRequest = z.infer<typeof createSecretRequestSchema>;

/** `PUT /v1/secrets/{id}` body: the new value replaces the current one as a new version. */
export const updateSecretRequestSchema = z.strictObject({ value: secretValueSchema });
export type UpdateSecretRequest = z.infer<typeof updateSecretRequestSchema>;

/** What a create or update answers with: the reference and the version, never the value. */
export const secretWriteResponseSchema = z.strictObject({
  secretId: uuidV7Schema,
  secretRef: z.string(),
  version: z.number().int().min(1),
});
export type SecretWriteResponse = z.infer<typeof secretWriteResponseSchema>;

/**
 * The only shape a secret is ever read back in. It deliberately has no `value` and no `envelope`
 * (strict, so a stray field cannot be serialised): reading a secret is the internal resolve path's job.
 */
export const secretMetadataSchema = z.strictObject({
  secretId: uuidV7Schema,
  secretRef: z.string(),
  name: z.string(),
  type: secretTypeSchema.nullable(),
  purpose: z.string().nullable(),
  backend: secretBackendSchema,
  status: secretStatusSchema,
  currentVersion: z.number().int().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type SecretMetadata = z.infer<typeof secretMetadataSchema>;
