import { z } from 'zod';

import { tenantSlugSchema } from './entities/tenancy.js';
import { LIMITS } from './limits.js';
import { uuidV7Schema } from './primitives.js';

/**
 * Self-service signup contracts (TENANT-004, F13): a prospective Org Owner submits an e-mail address and an
 * organisation name, proves the address with a single-use token, and only then does the tenant exist.
 * `@blackwing/contracts` is the one place the API, the console and the OpenAPI document read these from.
 */

/** Organisation name bounds (TENANT-004 requirement 2). */
export const SIGNUP_ORG_NAME_MIN = 2;
export const SIGNUP_ORG_NAME_MAX = 100;

/** Slug bounds for a signup (TENANT-004 requirement 6); tighter than the table's 3-63. */
export const SIGNUP_SLUG_MIN = 3;
export const SIGNUP_SLUG_MAX = 40;

/** A verification token is 256 random bits, base64url without padding. */
export const SIGNUP_TOKEN_BYTES = 32;
/** Longest token the verify endpoint reads before it answers `SIGNUP_TOKEN_INVALID` (a real one is 43). */
export const SIGNUP_TOKEN_INPUT_MAX = 512;

/** Control and format characters (CR/LF, bidi overrides, zero-width joiners) have no place in a name. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/** `POST /v1/signup` body. The name is NFC-normalised and trimmed before the length rules apply. */
export const signupRequestSchema = z.strictObject({
  email: z.email().max(LIMITS.emailMax),
  orgName: z
    .string()
    .normalize('NFC')
    .trim()
    .min(SIGNUP_ORG_NAME_MIN)
    .max(SIGNUP_ORG_NAME_MAX)
    .refine((value) => !CONTROL_OR_FORMAT.test(value), 'must not contain control characters'),
});
export type SignupRequest = z.infer<typeof signupRequestSchema>;

/**
 * The only answer to `POST /v1/signup`: identical whether or not the address already has an account, so the
 * endpoint cannot be used to enumerate customers.
 */
export const signupAcceptedSchema = z.strictObject({ status: z.literal('verification_requested') });
export type SignupAccepted = z.infer<typeof signupAcceptedSchema>;

/** `POST /v1/signup/verify` body. Any value that is not a live token is answered `SIGNUP_TOKEN_INVALID`. */
export const signupVerifyRequestSchema = z.strictObject({
  token: z.string().min(1).max(SIGNUP_TOKEN_INPUT_MAX),
});
export type SignupVerifyRequest = z.infer<typeof signupVerifyRequestSchema>;

/**
 * What a valid token produced: a new tenant, or, when the address already belongs to an account, nothing
 * (the caller goes to login; there is never a second tenant created silently).
 */
export const signupVerifiedSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('tenant_created'),
    tenantId: uuidV7Schema,
    slug: tenantSlugSchema,
  }),
  z.strictObject({ outcome: z.literal('existing_account') }),
]);
export type SignupVerified = z.infer<typeof signupVerifiedSchema>;

/** `signups.status` (TENANT-004 requirement 1). */
export const SIGNUP_STATUSES = ['pending', 'verified', 'expired', 'cancelled'] as const;
export const signupStatusSchema = z.enum(SIGNUP_STATUSES);
export type SignupStatus = z.infer<typeof signupStatusSchema>;
