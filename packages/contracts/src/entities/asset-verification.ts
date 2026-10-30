import { z } from 'zod';

import { verificationMethodSchema, verificationStatusSchema } from './asset.js';
import { isoDateTimeSchema, uuidV7Schema } from '../primitives.js';

/**
 * Ownership verification contracts (ASSET-003, CONTEXT_PACK §8.10). A verification challenge carries the token the
 * owner publishes at the location the method names; a probe checks that location and the state machine decides.
 * The asset's own columns (`verification_status`, `verification_method`, `verified_at`, `verification_expires_at`)
 * are the source of truth; a challenge row is the evidence and the probe budget of one attempt.
 */

/** `verification_challenges.status`. `pending` is the only state a probe may act on. */
export const VERIFICATION_CHALLENGE_STATUSES = [
  'pending',
  'passed',
  'failed',
  'expired',
  'cancelled',
] as const;
export const verificationChallengeStatusSchema = z.enum(VERIFICATION_CHALLENGE_STATUSES);
export type VerificationChallengeStatus = z.infer<typeof verificationChallengeStatusSchema>;

/** Every verification token starts with this prefix, so a published value is recognisable by its owner. */
export const VERIFICATION_TOKEN_PREFIX = 'blackwing-site-verification=';
/** Entropy of a token: 32 CSPRNG bytes, base32 encoded without padding (52 characters). */
export const VERIFICATION_TOKEN_BYTES = 32;
const BITS_PER_BYTE = 8;
const BITS_PER_BASE32_CHARACTER = 5;
/** Shortest token the table accepts: the prefix plus the base32 length of `VERIFICATION_TOKEN_BYTES`. */
export const VERIFICATION_TOKEN_MIN_LENGTH =
  VERIFICATION_TOKEN_PREFIX.length +
  Math.ceil((VERIFICATION_TOKEN_BYTES * BITS_PER_BYTE) / BITS_PER_BASE32_CHARACTER);

/** Body of `POST /v1/assets/{id}/verification`: the method the owner chooses to prove control with. */
export const startVerificationBodySchema = z.strictObject({
  method: verificationMethodSchema,
});
export type StartVerificationBody = z.output<typeof startVerificationBodySchema>;

/** The challenge as the owner sees it. The token is returned only to callers with `asset:verify`. */
export const verificationChallengeViewSchema = z.strictObject({
  id: uuidV7Schema,
  method: verificationMethodSchema,
  status: verificationChallengeStatusSchema,
  token: z.string().min(VERIFICATION_TOKEN_MIN_LENGTH),
  /** Where the token must appear (DNS name or URL). `null` for a manual letter, which has no probe location. */
  expectedLocation: z.string().min(1).nullable(),
  attempts: z.number().int().min(0),
  maxCheckAttempts: z.number().int().min(1),
  expiresAt: isoDateTimeSchema,
  lastCheckedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type VerificationChallengeView = z.output<typeof verificationChallengeViewSchema>;

/**
 * The verification state of one asset: the asset's columns plus its latest challenge (`null` when none was ever
 * issued). `verificationExpiresAt` is set only for a verified asset.
 */
export const assetVerificationViewSchema = z.strictObject({
  assetId: uuidV7Schema,
  verificationStatus: verificationStatusSchema,
  verificationMethod: verificationMethodSchema.nullable(),
  verifiedAt: isoDateTimeSchema.nullable(),
  verificationExpiresAt: isoDateTimeSchema.nullable(),
  challenge: verificationChallengeViewSchema.nullable(),
});
export type AssetVerificationView = z.output<typeof assetVerificationViewSchema>;
