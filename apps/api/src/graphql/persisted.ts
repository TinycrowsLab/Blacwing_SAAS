import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { GraphQLError } from 'graphql';
import { z } from 'zod';

import { canonicalQueryText, PERSISTED_HASH_PATTERN } from '@blackwing/contracts';

import { formatGraphqlErrors, type PersistedQueryCode } from './errors.js';

import type { GraphqlMetrics } from './metrics.js';
import type { Logger } from '@blackwing/logger';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Earlier manifest generations kept valid so a rollout can run a new client against an old server, or the
 * reverse, for one grace window (API-GQL-PERSIST). Older generations are dropped.
 */
export const PERSISTED_PREVIOUS_GENERATIONS = 2;

/** Hash to canonical query text. */
export type PersistedManifest = ReadonlyMap<string, string>;

/** The loaded manifests: the current generation, and up to `PERSISTED_PREVIOUS_GENERATIONS` earlier ones. */
export interface PersistedManifests {
  readonly current: PersistedManifest;
  readonly previous: readonly PersistedManifest[];
}

/** The manifest files: the current generation (`persisted.json`) and the earlier ones (`persisted.previous.json`). */
export interface PersistedManifestFiles {
  readonly current: string;
  readonly previous: string;
}

const MESSAGES: Readonly<Record<PersistedQueryCode, string>> = {
  persisted_manifest_unavailable:
    'No persisted GraphQL queries are loaded, so every GraphQL request is refused until the manifest is deployed.',
  persisted_query_not_found:
    'Unknown persisted query: send the id of an operation from the reviewed manifest.',
  persisted_query_required:
    'Only persisted queries are accepted: send the sha256 id, not the query text.',
  persisted_query_hash_mismatch: 'The sha256 id does not match the query text.',
};

/** What the gate decided for one request. */
export type PersistedDecision =
  /** `query` (when set) replaces the request's document: the id resolved to its reviewed text. */
  | { readonly allow: true; readonly hash?: string; readonly query?: string }
  | { readonly allow: false; readonly code: PersistedQueryCode; readonly hash?: string };

const manifestSchema = z.record(z.string().regex(PERSISTED_HASH_PATTERN), z.string().min(1));
const previousSchema = z.array(manifestSchema).max(PERSISTED_PREVIOUS_GENERATIONS);

/** SHA-256 of the canonical query text: the id a client sends and the manifest key. */
export function persistedHash(queryText: string): string {
  return createHash('sha256').update(canonicalQueryText(queryText)).digest('hex');
}

function safeHash(text: string): string | undefined {
  try {
    return persistedHash(text);
  } catch {
    return undefined;
  }
}

/** Keeps only the entries whose text hashes to their key; a tampered entry is logged by id and dropped. */
function verifiedEntries(
  generation: Readonly<Record<string, string>>,
  logger: Logger,
): PersistedManifest {
  const map = new Map<string, string>();
  for (const [hash, text] of Object.entries(generation)) {
    if (safeHash(text) === hash) map.set(hash, text);
    else logger.error({ hash }, 'graphql.persisted_entry_rejected');
  }
  return map;
}

function readJson(file: string, logger: Logger): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    logger.error({ file }, 'graphql.persisted_manifest_unreadable');
    return undefined;
  }
}

/**
 * Reads the manifests at boot; they are immutable at runtime, and a deploy reloads them. Fail closed: a missing,
 * unreadable or malformed file loads as empty and is logged as an error, so production refuses every GraphQL
 * request. The current manifest is required; a bad previous-generation file loses only the grace window.
 */
export function loadPersistedManifests(
  files: PersistedManifestFiles,
  logger: Logger,
): PersistedManifests {
  const currentParsed = manifestSchema.safeParse(readJson(files.current, logger));
  if (!currentParsed.success)
    logger.error({ file: files.current }, 'graphql.persisted_manifest_invalid');
  const current = currentParsed.success
    ? verifiedEntries(currentParsed.data, logger)
    : new Map<string, string>();
  if (current.size === 0)
    logger.error({ file: files.current }, 'graphql.persisted_manifest_unavailable');

  const previousParsed = previousSchema.safeParse(readJson(files.previous, logger));
  if (!previousParsed.success)
    logger.error({ file: files.previous }, 'graphql.persisted_manifest_invalid');
  const previous = previousParsed.success
    ? previousParsed.data.map((generation) => verifiedEntries(generation, logger))
    : [];
  return { current, previous };
}

/** The persisted-query id a request carries: `extensions.persistedQuery.sha256Hash`, else a top-level `id`. */
function idOf(body: Readonly<Record<string, unknown>>): string | undefined {
  const extensions = body.extensions;
  if (typeof extensions === 'object' && extensions !== null) {
    const persisted = (extensions as Record<string, unknown>).persistedQuery;
    if (typeof persisted === 'object' && persisted !== null) {
      const hash = (persisted as Record<string, unknown>).sha256Hash;
      if (typeof hash === 'string') return hash;
    }
  }
  const id = body.id;
  return typeof id === 'string' ? id : undefined;
}

function lookup(manifests: PersistedManifests, hash: string): string | undefined {
  const current = manifests.current.get(hash);
  if (current !== undefined) return current;
  for (const generation of manifests.previous) {
    const retired = generation.get(hash);
    if (retired !== undefined) return retired;
  }
  return undefined;
}

/**
 * The gate's decision for one request, before Mercurius runs it. In production (`persistedOnly`) only manifest ids
 * run: a raw document is refused, and an empty current manifest refuses everything. Development also runs raw
 * documents, and verifies an id sent alongside its document. Pure, so the rules are testable without a server.
 */
export function decidePersisted(
  envelope: unknown,
  manifests: PersistedManifests,
  persistedOnly: boolean,
): PersistedDecision {
  const refuse = (code: PersistedQueryCode, hash?: string): PersistedDecision =>
    hash === undefined ? { allow: false, code } : { allow: false, code, hash };
  if (persistedOnly && manifests.current.size === 0)
    return refuse('persisted_manifest_unavailable');
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return persistedOnly ? refuse('persisted_query_required') : { allow: true };
  }
  const body = envelope as Record<string, unknown>;
  const query = typeof body.query === 'string' && body.query.trim() !== '' ? body.query : undefined;
  const hash = idOf(body);

  if (hash === undefined)
    return persistedOnly || query === undefined ? refuseNoId(persistedOnly) : { allow: true };
  if (query !== undefined) {
    // An id sent with its document: production never takes documents; development checks the id against it.
    if (persistedOnly) return refuse('persisted_query_required', hash);
    return safeHash(query) === hash
      ? { allow: true, hash }
      : refuse('persisted_query_hash_mismatch', hash);
  }
  const text = PERSISTED_HASH_PATTERN.test(hash) ? lookup(manifests, hash) : undefined;
  return text === undefined
    ? refuse('persisted_query_not_found', hash)
    : { allow: true, hash, query: text };
}

/** No id and no document: production refuses; development passes it on so Mercurius reports its own error. */
function refuseNoId(persistedOnly: boolean): PersistedDecision {
  return persistedOnly ? { allow: false, code: 'persisted_query_required' } : { allow: true };
}

/** A GET carries `query` and `extensions` (a JSON string) in the query string. */
function envelopeOfGet(query: Readonly<Record<string, unknown>>): Record<string, unknown> {
  let extensions: unknown = undefined;
  if (typeof query.extensions === 'string') {
    try {
      extensions = JSON.parse(query.extensions);
    } catch {
      extensions = undefined;
    }
  }
  return { query: query.query, extensions };
}

export interface PersistedGateOptions {
  readonly manifests: PersistedManifests;
  readonly persistedOnly: boolean;
  readonly metrics: GraphqlMetrics;
  readonly logger: Logger;
}

/**
 * The Fastify route hook that enforces the gate on `/graphql` (GET and POST), before Mercurius reads the document.
 * A refusal answers with a GraphQL error body at status 200, like every GraphQL error. An accepted id has its
 * document filled in with the reviewed text. The query text is never logged; only the id is.
 */
export function persistedQueryGate(options: PersistedGateOptions) {
  const { manifests, persistedOnly, metrics, logger } = options;
  return async function enforcePersistedQueries(request: FastifyRequest, reply: FastifyReply) {
    const isGet = request.method === 'GET';
    const envelope: unknown = isGet
      ? envelopeOfGet(request.query as Record<string, unknown>)
      : request.body;
    const decision = decidePersisted(envelope, manifests, persistedOnly);
    if (decision.allow) {
      if (decision.hash !== undefined && decision.query !== undefined) metrics.persistedHits.inc();
      if (decision.query !== undefined) {
        if (isGet) request.query = { ...(request.query as object), query: decision.query };
        else request.body = { ...(request.body as object), query: decision.query };
      }
      return undefined;
    }
    if (decision.code === 'persisted_query_not_found') metrics.persistedMisses.inc();
    metrics.persistedRejected.inc({ reason: decision.code });
    logger.warn(
      decision.hash === undefined
        ? { reason: decision.code }
        : { reason: decision.code, hash: decision.hash },
      'graphql.persisted_query_rejected',
    );
    const error = new GraphQLError(MESSAGES[decision.code], {
      extensions: { code: decision.code },
    });
    const { statusCode, response } = formatGraphqlErrors({ errors: [error] });
    return reply.code(statusCode).send(response);
  };
}
