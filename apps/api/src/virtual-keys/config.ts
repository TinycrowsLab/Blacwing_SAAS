import { z } from 'zod';

import { type EnvSource, loadConfig } from '@blackwing/config';
import { DEFAULT_VIRTUAL_KEY_TTL_SECONDS, MAX_VIRTUAL_KEY_TTL_SECONDS } from '@blackwing/contracts';

const DEFAULT_MINT_RATE_LIMIT_PER_MINUTE = 60;
const DEFAULT_IDENTITY_HEADER = 'x-bw-mesh-identity';

/** Comma-separated list; empty means "none", which refuses every request (fail closed). */
const list = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== ''),
  );

/**
 * Environment of the virtual-key endpoints (GATEWAY-002, #405). The internal source policy mirrors the Run
 * Broker's: the mint, revoke and validate endpoints answer only to the internal network and mesh identities.
 */
export const virtualKeysEnvSchema = z.object({
  /** Lifetime of a minted key when the caller does not ask for one (`GATEWAY_VKEY_TTL_SECONDS`). */
  GATEWAY_VKEY_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_VIRTUAL_KEY_TTL_SECONDS)
    .default(DEFAULT_VIRTUAL_KEY_TTL_SECONDS),
  /** Source CIDRs allowed to call the internal key endpoints. Empty refuses every request. */
  VKEY_INTERNAL_ALLOWED_CIDRS: list,
  /** Header the mesh sets to the caller's workload identity. */
  VKEY_INTERNAL_MESH_IDENTITY_HEADER: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]*$/)
    .default(DEFAULT_IDENTITY_HEADER),
  /** Accepted identity values. Empty refuses every request. */
  VKEY_INTERNAL_MESH_IDENTITIES: list,
  /** Mint requests allowed per tenant per minute (per process). */
  VKEY_MINT_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_MINT_RATE_LIMIT_PER_MINUTE),
});
export type VirtualKeysConfig = z.output<typeof virtualKeysEnvSchema>;

/** Parses the virtual-key configuration; throws `ConfigValidationError` (key names only). */
export function loadVirtualKeysConfig(source?: EnvSource): Readonly<VirtualKeysConfig> {
  return loadConfig(virtualKeysEnvSchema, source);
}
