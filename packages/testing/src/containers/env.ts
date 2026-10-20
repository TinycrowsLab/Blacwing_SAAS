import { z } from 'zod';

/**
 * The environment switches the container helpers read. This is test tooling, so it reads
 * `process.env` itself (product code uses `@blackwing/config`), but it still validates with Zod and
 * reads nothing beyond these keys.
 */
const flag = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((value) =>
    value === undefined || value === '' ? undefined : value === 'true' || value === '1',
  );

const testEnvSchema = z.object({
  /** Set by GitHub Actions and most CI systems. Forces reuse off. */
  CI: z
    .string()
    .optional()
    .transform(
      (value) => value !== undefined && value !== '' && value !== 'false' && value !== '0',
    ),
  /** Dev opt-in for container reuse across runs (`true`). Ignored in CI. */
  BW_TESTCONTAINERS_REUSE: flag,
  /** Testcontainers' own kill switch for reuse. */
  TESTCONTAINERS_REUSE_ENABLE: flag,
  /** Where the per-developer reuse secret lives (defaults to `~/.cache`). */
  XDG_CACHE_HOME: z.string().min(1).optional(),
});

export type TestEnv = z.infer<typeof testEnvSchema>;

/** Parses the relevant variables from `env` (defaults to `process.env`). Invalid flag values throw. */
export function readTestEnv(env: NodeJS.ProcessEnv = process.env): TestEnv {
  return testEnvSchema.parse({
    CI: env.CI,
    BW_TESTCONTAINERS_REUSE: env.BW_TESTCONTAINERS_REUSE,
    TESTCONTAINERS_REUSE_ENABLE: env.TESTCONTAINERS_REUSE_ENABLE,
    XDG_CACHE_HOME: env.XDG_CACHE_HOME,
  });
}

/**
 * Decides whether a container may be reused across test runs.
 *
 * - In CI, never (every run starts clean and tears down: the CI `--no-reuse` rule).
 * - `TESTCONTAINERS_REUSE_ENABLE=false` disables it everywhere.
 * - Otherwise an explicit `requested` value wins, then `BW_TESTCONTAINERS_REUSE`, then off.
 *
 * Reuse is opt-in on dev hosts because the dev box is shared: a reused container outlives the test
 * process, so it is only safe for helpers that isolate every call (fresh database, bucket, key prefix).
 */
export function resolveReuse(
  requested: boolean | undefined,
  env: TestEnv = readTestEnv(),
): boolean {
  if (env.CI) return false;
  if (env.TESTCONTAINERS_REUSE_ENABLE === false) return false;
  return requested ?? env.BW_TESTCONTAINERS_REUSE ?? false;
}
