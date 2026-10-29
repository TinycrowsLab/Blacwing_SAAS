import { z } from 'zod';

import {
  MAX_CURSOR_LENGTH,
  SURFACE_NODE_KINDS,
  type SurfaceNodeKind,
  surfaceNodeKindSchema,
} from '@blackwing/contracts';
import { AppError } from '@blackwing/errors';

import {
  GRAPH_VIZ_DEFAULT_LIMIT,
  GRAPH_VIZ_KINDS_PARAM_MAX,
  GRAPH_VIZ_MAX_LIMIT,
} from './limits.js';

/** A decimal in [0, 1]: `0`, `0.5`, `.5`, `1`, `1.0`. Anything else is refused. */
const UNIT_INTERVAL = /^(?:0|1)(?:\.0+)?$|^0?\.\d+$/;
const INTEGER = /^\d+$/;

/** The parsed `GET /v1/runs/{runId}/surface` query. */
export interface SurfaceQuery {
  /** Node kinds to keep; absent keeps every kind. */
  readonly kinds?: readonly SurfaceNodeKind[];
  readonly minConfidence: number;
  /** The opaque cursor of the page to continue, as the server issued it. */
  readonly cursor?: string;
  readonly limit: number;
}

const querySchema = z.object({
  kinds: z.string().max(GRAPH_VIZ_KINDS_PARAM_MAX).optional(),
  minConfidence: z.string().regex(UNIT_INTERVAL).transform(Number).optional(),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  limit: z
    .string()
    .regex(INTEGER)
    .transform(Number)
    .pipe(z.number().int().min(1).max(GRAPH_VIZ_MAX_LIMIT))
    .optional(),
});

/** `kinds=host,service`: each name must be a surface node kind; an empty or unknown name is refused. */
function parseKinds(raw: string | undefined): readonly SurfaceNodeKind[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw.split(',').map((name) => name.trim());
  const kinds: SurfaceNodeKind[] = [];
  for (const name of names) {
    const parsed = surfaceNodeKindSchema.safeParse(name);
    if (!parsed.success) return undefined;
    if (!kinds.includes(parsed.data)) kinds.push(parsed.data);
  }
  return kinds;
}

/**
 * Parses and validates the query of the surface view. Every failure is `INVALID_QUERY` (400): an unknown kind, a
 * confidence outside [0, 1], a non-numeric or out-of-range `limit`. The cursor is checked by the codec, not here.
 */
export function parseSurfaceQuery(raw: Readonly<Record<string, unknown>>): SurfaceQuery {
  const parsed = querySchema.safeParse(raw);
  const invalid = (detail: string) =>
    new AppError('INVALID_QUERY', 'invalid surface query parameters', { detail });
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? 'query');
    throw invalid(`${field} is not valid (kinds=${SURFACE_NODE_KINDS.join('|')})`);
  }
  const kinds = parseKinds(parsed.data.kinds);
  if (parsed.data.kinds !== undefined && kinds === undefined) {
    throw invalid(`kinds must be a comma list of ${SURFACE_NODE_KINDS.join(', ')}`);
  }
  return {
    ...(kinds === undefined ? {} : { kinds }),
    minConfidence: parsed.data.minConfidence ?? 0,
    ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
    limit: parsed.data.limit ?? GRAPH_VIZ_DEFAULT_LIMIT,
  };
}
