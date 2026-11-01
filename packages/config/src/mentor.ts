// MENTOR-002 (#421): the mentor's transcript summary is bounded by a character budget. The default is 6000 and
// the value is read from env once at load. Out-of-range input fails the load (fail closed), it is never clamped.
import { z } from 'zod';

/** Default budget of the serialised mentor summary, in characters (MENTOR-002 #421). */
export const MENTOR_SUMMARY_DEFAULT_MAX_CHARS = 6_000;
/** Smallest budget accepted: below this the fixed fields alone would not fit. */
export const MENTOR_SUMMARY_MIN_MAX_CHARS = 1_024;
/** Largest budget accepted for `MENTOR_SUMMARY_MAX_CHARS`. */
export const MENTOR_SUMMARY_MAX_MAX_CHARS = 100_000;

const ISSUE_CHARS = {
  message: `must be an integer ${String(MENTOR_SUMMARY_MIN_MAX_CHARS)}..${String(MENTOR_SUMMARY_MAX_MAX_CHARS)}`,
} as const;

/** Positive integer from env text within the summary budget bounds. Decimal digits only, no sign. */
const zSummaryChars = z.string().transform((raw, ctx): number => {
  if (!/^[1-9]\d{0,6}$/.test(raw)) {
    ctx.addIssue({ code: 'custom', ...ISSUE_CHARS });
    return z.NEVER;
  }
  const value = Number(raw);
  if (value < MENTOR_SUMMARY_MIN_MAX_CHARS || value > MENTOR_SUMMARY_MAX_MAX_CHARS) {
    ctx.addIssue({ code: 'custom', ...ISSUE_CHARS });
    return z.NEVER;
  }
  return value;
});

/** Env slice of the mentor summariser. */
export const mentorEnvShape = {
  MENTOR_SUMMARY_MAX_CHARS: zSummaryChars.default(MENTOR_SUMMARY_DEFAULT_MAX_CHARS),
} as const;
export const mentorEnvSchema = z.object(mentorEnvShape);
export type MentorEnv = z.output<typeof mentorEnvSchema>;
