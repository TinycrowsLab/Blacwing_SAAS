/** Default `BW_TOOL_OUTPUT_MAX_BYTES`: the largest tool output returned inline to the model. */
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 131_072;

const KIB = 1024;
const MIN_OUTPUT_MAX_BYTES = KIB;
const MAX_OUTPUT_MIB = 16;
const MAX_OUTPUT_MAX_BYTES = KIB * KIB * MAX_OUTPUT_MIB;

/**
 * Reads `BW_TOOL_OUTPUT_MAX_BYTES`. An unset value means the default; anything that is not a plain integer
 * inside the allowed range throws, so a misconfigured sandbox fails at start instead of silently running
 * with no limit.
 */
export function resolveOutputMaxBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.BW_TOOL_OUTPUT_MAX_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_TOOL_OUTPUT_MAX_BYTES;
  const value = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_OUTPUT_MAX_BYTES ||
    value > MAX_OUTPUT_MAX_BYTES
  ) {
    throw new RangeError(
      `BW_TOOL_OUTPUT_MAX_BYTES must be an integer between ${String(MIN_OUTPUT_MAX_BYTES)} and ${String(MAX_OUTPUT_MAX_BYTES)}`,
    );
  }
  return value;
}
