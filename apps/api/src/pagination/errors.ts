import { ApiProblemError } from '../errors/problem-errors.js';

/** A cursor that is malformed, forged, from another sort/filter, or from another cursor version (400). */
export function invalidCursor(
  detail = 'The cursor is not valid for this request.',
): ApiProblemError {
  return new ApiProblemError('invalid_cursor', 'invalid cursor', { detail });
}

/** A filter or sort outside the endpoint's allowlist, or with an unusable value (400). */
export function invalidFilter(detail: string): ApiProblemError {
  return new ApiProblemError('invalid_filter', 'invalid filter', { detail });
}

/** A malformed `limit` (zero, negative, not an integer) or `cursor` shape (400 `bad_request`). */
export function badPageQuery(detail: string): ApiProblemError {
  return new ApiProblemError('bad_request', 'invalid page query', { detail });
}
