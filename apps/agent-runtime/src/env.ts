import { z } from 'zod';

import { loadConfig, zString } from '@blackwing/config';

/** The only environment the runtime reads: the path of the mounted session descriptor (RUNTIME-001). */
const runtimeEnvSchema = z.object({
  BW_SESSION_DESCRIPTOR: zString(),
});
export type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;

/** Loads the runtime environment through `@blackwing/config`; throws `ConfigValidationError` when unset. */
export function loadRuntimeEnv(source: Readonly<Record<string, string | undefined>>): RuntimeEnv {
  return loadConfig(runtimeEnvSchema, source);
}
