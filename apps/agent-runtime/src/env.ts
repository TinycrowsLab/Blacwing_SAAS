import { z } from 'zod';

import { loadConfig, zString } from '@blackwing/config';

/** Default bound on one PreToolUse decision, in milliseconds (RUNTIME-005). */
export const PDP_TIMEOUT_MS_DEFAULT = 1500;
/** Largest bound an operator may set: one minute. */
const PDP_TIMEOUT_MS_MAX = 60_000;

/**
 * The only environment the runtime reads: the mounted session descriptor (RUNTIME-001) and the bound on each
 * PreToolUse policy decision (RUNTIME-005).
 */
const runtimeEnvSchema = z.object({
  BW_SESSION_DESCRIPTOR: zString(),
  BW_PDP_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(PDP_TIMEOUT_MS_MAX)
    .default(PDP_TIMEOUT_MS_DEFAULT),
});
export type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;

/** Loads the runtime environment through `@blackwing/config`; throws `ConfigValidationError` when unset. */
export function loadRuntimeEnv(source: Readonly<Record<string, string | undefined>>): RuntimeEnv {
  return loadConfig(runtimeEnvSchema, source);
}
