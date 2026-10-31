// CODESPEC-004 (#511): the cap on source-to-sink leads one white-box pass may emit. The env key defaults to 200 and
// is read once at load. An invalid value fails the load (fail closed), it is never clamped.
import { z } from 'zod';

/** Default `WHITEBOX_MAX_LEADS` (CODESPEC-004 requirement 5). */
export const WHITEBOX_MAX_LEADS_DEFAULT = 200;
/** Largest lead cap accepted for `WHITEBOX_MAX_LEADS`. Keeps a typo from turning the bound off. */
export const WHITEBOX_MAX_LEADS_LIMIT = 10_000;

/** Positive integer from env text: decimal digits only, no sign, no leading zero, 1..max. */
const zWhiteboxInt = (max: number): z.ZodType<number, string> =>
  z.string().transform((raw, ctx): number => {
    if (!/^[1-9]\d{0,9}$/.test(raw)) {
      ctx.addIssue({ code: 'custom', message: 'must be a positive integer' });
      return z.NEVER;
    }
    const value = Number(raw);
    if (value > max) {
      ctx.addIssue({ code: 'custom', message: `must be at most ${String(max)}` });
      return z.NEVER;
    }
    return value;
  });

/** Env slice for the white-box pass. */
export const whiteboxEnvShape = {
  WHITEBOX_MAX_LEADS: zWhiteboxInt(WHITEBOX_MAX_LEADS_LIMIT).default(WHITEBOX_MAX_LEADS_DEFAULT),
};

export const whiteboxEnvSchema = z.object(whiteboxEnvShape);
export type WhiteboxEnv = z.output<typeof whiteboxEnvSchema>;
