// Virtual model key contracts (GATEWAY-002, #405, CONTEXT_PACK §4.1, §8.7). The internal mint, revoke and
// validate endpoints of the API and the gateway's request context share these shapes. The raw `bwk_` key
// appears only in the mint response; nothing else in the contracts carries it.

import { z } from 'zod';

import { uuidV7Schema } from './primitives.js';

export const VIRTUAL_KEY_PREFIX = 'bwk_';
/** Body length of a key, see `@blackwing/crypto` `VIRTUAL_KEY_BODY_LENGTH`. */
export const VIRTUAL_KEY_PATTERN = /^bwk_[0-9A-Za-z]{43}$/;
/** Default lifetime of a minted key (`GATEWAY_VKEY_TTL_SECONDS`). */
export const DEFAULT_VIRTUAL_KEY_TTL_SECONDS = 3600;
/** Upper bound on a key lifetime: keys are short-lived by design (§8.7). */
export const MAX_VIRTUAL_KEY_TTL_SECONDS = 86_400;
/** Largest number of keys one revoke request names. */
export const MAX_VIRTUAL_KEY_REVOKE_IDS = 100;
/** Persona names are lowercase kebab-case (the roster in `@blackwing/agents`). */
const PERSONA_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
/** Caps of the budget context, mirrored by the key row checks in `@blackwing/db`. */
const MAX_COST_CAP_USD = 10_000;
const MAX_REQUESTS_PER_KEY = 1_000_000;

/** Budget context carried by a key (F38). The gateway reads it; enforcement is GATEWAY-011. */
export const virtualKeyBudgetContextSchema = z
  .object({
    costCapUsd: z.number().positive().max(MAX_COST_CAP_USD).optional(),
    maxRequests: z.number().int().positive().max(MAX_REQUESTS_PER_KEY).optional(),
  })
  .strict();
export type VirtualKeyBudgetContext = z.infer<typeof virtualKeyBudgetContextSchema>;

/** Body of `POST /internal/keys:mint`. */
export const virtualKeyMintRequestSchema = z
  .object({
    tenantId: uuidV7Schema,
    runId: uuidV7Schema,
    sessionId: uuidV7Schema,
    persona: z.string().regex(PERSONA_PATTERN, 'must be a lowercase persona name'),
    ttlSeconds: z.number().int().positive().max(MAX_VIRTUAL_KEY_TTL_SECONDS).optional(),
    budgetContext: virtualKeyBudgetContextSchema.default({}),
  })
  .strict();
export type VirtualKeyMintRequest = z.input<typeof virtualKeyMintRequestSchema>;

/** Response of `POST /internal/keys:mint`. `key` is shown once and never stored. */
export const virtualKeyMintResponseSchema = z
  .object({
    key: z.string().regex(VIRTUAL_KEY_PATTERN),
    virtualKeyId: uuidV7Schema,
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type VirtualKeyMintResponse = z.infer<typeof virtualKeyMintResponseSchema>;

/**
 * Body of `POST /internal/keys:revoke`: explicit key ids, or every key of a run. The tenant is always named,
 * so a revoke can never reach another tenant's keys (fail closed).
 */
export const virtualKeyRevokeRequestSchema = z.union([
  z
    .object({
      tenantId: uuidV7Schema,
      virtualKeyIds: z.array(uuidV7Schema).min(1).max(MAX_VIRTUAL_KEY_REVOKE_IDS),
    })
    .strict(),
  z.object({ tenantId: uuidV7Schema, runId: uuidV7Schema }).strict(),
]);
export type VirtualKeyRevokeRequest = z.infer<typeof virtualKeyRevokeRequestSchema>;

/** Response of `POST /internal/keys:revoke`: the keys this call revoked (already revoked keys are skipped). */
export const virtualKeyRevokeResponseSchema = z
  .object({
    revokedVirtualKeyIds: z.array(uuidV7Schema),
  })
  .strict();
export type VirtualKeyRevokeResponse = z.infer<typeof virtualKeyRevokeResponseSchema>;

/** Body of `POST /internal/keys:validate` (internal use and tests). */
export const virtualKeyValidateRequestSchema = z
  .object({ key: z.string().regex(VIRTUAL_KEY_PATTERN) })
  .strict();
export type VirtualKeyValidateRequest = z.infer<typeof virtualKeyValidateRequestSchema>;

/** The request context a valid key yields (`tenantId`, `runId`, `sessionId`, `persona`, `budgetContext`). */
export const virtualKeyContextSchema = z
  .object({
    virtualKeyId: uuidV7Schema,
    tenantId: uuidV7Schema,
    runId: uuidV7Schema,
    sessionId: uuidV7Schema,
    persona: z.string().regex(PERSONA_PATTERN),
    budgetContext: virtualKeyBudgetContextSchema,
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type VirtualKeyContext = z.infer<typeof virtualKeyContextSchema>;
