import { ApiProblemError } from '../errors/problem-errors.js';
import { problemRegistry } from '../errors/registry.js';

import type { ZodError } from 'zod';

/** The wire code of an unknown IANA zone. Registry codes are lower snake_case (§9), so it is not upper-cased. */
export const INVALID_TIMEZONE_CODE = 'invalid_timezone';

problemRegistry.register(INVALID_TIMEZONE_CODE, { status: 422, title: 'Invalid time zone' });

/** The zone check of the settings contract reports a `custom` issue on `displayTimezone` only. */
export function isInvalidTimezoneIssue(issue: ZodError['issues'][number]): boolean {
  return issue.code === 'custom' && issue.path[0] === 'displayTimezone';
}

export function invalidTimezoneError(): ApiProblemError {
  return new ApiProblemError(INVALID_TIMEZONE_CODE, 'displayTimezone is not a known time zone', {
    detail: 'displayTimezone must be an IANA time zone name, such as Europe/Berlin.',
  });
}
