import { PreconditionFailedError, PreconditionRequiredError } from '@blackwing/errors';

import { versionFromEtag } from './etag.js';

/** A parsed `If-Match` header: `*` ("must exist") or a list of strong entity-tags. */
export type IfMatch =
  { readonly kind: 'any' } | { readonly kind: 'tags'; readonly etags: string[] };

/** What a mutation may rely on once `If-Match` has been checked against the current resource. */
export interface IfMatchResult {
  /** The current ETag, quoted. */
  readonly etag: string;
  /**
   * The `state_version` the client expects, to pass into `UPDATE ... WHERE state_version = ?`.
   * Undefined for `If-Match: *` and for content-hash ETags.
   */
  readonly expectedVersion: number | undefined;
}

const TAG = /\s*(W\/)?"([^"\\\s,]*)"\s*(?:,|$)/y;

function required(detail: string): PreconditionRequiredError {
  return new PreconditionRequiredError(detail, { detail });
}

function stale(detail: string): PreconditionFailedError {
  return new PreconditionFailedError(detail, { detail });
}

/**
 * Parses an `If-Match` header value. Returns undefined when the header is absent or blank. A weak
 * validator (`W/"..."`), a malformed list or `*` mixed with tags is unsupported and answers 428.
 */
export function parseIfMatch(header: string | readonly string[] | undefined): IfMatch | undefined {
  if (header === undefined) return undefined;
  const raw = (typeof header === 'string' ? header : header.join(',')).trim();
  if (raw === '') return undefined;
  if (raw === '*') return { kind: 'any' };
  const etags: string[] = [];
  let consumed = 0;
  while (consumed < raw.length) {
    TAG.lastIndex = consumed;
    const match = TAG.exec(raw);
    if (match === null) throw required('If-Match must be "*" or a list of quoted strong ETags.');
    if (match[1] !== undefined)
      throw required(
        'Weak ETags are not supported in If-Match; send the strong ETag from the GET.',
      );
    etags.push(`"${match[2] ?? ''}"`);
    consumed = TAG.lastIndex;
  }
  return { kind: 'tags', etags };
}

/**
 * Checks a mutation's `If-Match` against the current resource's ETag.
 *
 * - header absent, blank or weak/malformed: 428 `precondition_required`
 * - resource missing (`currentEtag` null/undefined): 412 `precondition_failed`, also for `*`
 * - no listed ETag equals the current one: 412 `precondition_failed` (the client must re-GET)
 *
 * The DB `WHERE state_version = ?` stays the source of truth; see {@link assertRowUpdated}.
 */
export function requireIfMatch(
  currentEtag: string | null | undefined,
  header: string | readonly string[] | undefined,
): IfMatchResult {
  const parsed = parseIfMatch(header);
  if (parsed === undefined) throw required('This resource requires an If-Match header.');
  if (currentEtag === null || currentEtag === undefined)
    throw stale('The resource no longer exists.');
  if (parsed.kind === 'any') return { etag: currentEtag, expectedVersion: undefined };
  if (!parsed.etags.includes(currentEtag))
    throw stale('The resource was modified; re-fetch it and retry.');
  return { etag: currentEtag, expectedVersion: versionFromEtag(currentEtag) };
}

/**
 * Maps a conditional update (`UPDATE ... WHERE state_version = ?`) that touched no row to 412:
 * either a concurrent writer won or the row is gone.
 */
export function assertRowUpdated(rowCount: number | null | undefined): void {
  if (rowCount === null || rowCount === undefined || rowCount < 1)
    throw stale('The resource was modified or deleted concurrently; re-fetch it and retry.');
}
