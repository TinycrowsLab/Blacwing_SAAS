import { z } from 'zod';

import { ValidationError } from '@blackwing/errors';

import mappings100 from './mappings/1.0.0.json' with { type: 'json' };
import { apiTop10RefSchema, cweRefSchema, owaspTop10RefSchema, wstgRefSchema } from './taxonomy.js';

/**
 * The versioned class-to-standard mapping dataset (FINDING-004, `mappings/<version>.json`). Each finding class
 * (the dotted id of a catalogued test class) maps to its default CWE candidates, OWASP Top 10 category, optional
 * API Top 10 category and WSTG tests. The version is pinned on every finding (CONTEXT_PACK §8.9), so a report
 * can be reproduced against the mapping that produced it. A dataset that names an unknown id does not load.
 */

const CLASS_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** Upper bounds per class entry (the same spirit as the taxonomy's per-finding caps). */
const MAX_CWE_CANDIDATES = 8;
const MAX_WSTG_REFS = 16;

const mappingEntrySchema = z.strictObject({
  cweCandidates: z.array(cweRefSchema).min(1).max(MAX_CWE_CANDIDATES),
  owaspTop10: owaspTop10RefSchema,
  apiTop10: apiTop10RefSchema.optional(),
  wstg: z.array(wstgRefSchema).max(MAX_WSTG_REFS),
});

const mappingDatasetSchema = z.strictObject({
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, 'must be semver'),
  mappings: z.record(z.string().regex(CLASS_ID, 'must be a dotted class id'), mappingEntrySchema),
});

export type MappingEntry = z.infer<typeof mappingEntrySchema>;
export type MappingDataset = z.infer<typeof mappingDatasetSchema>;

/**
 * Validates a raw mapping document and returns it normalised and frozen. It throws `ValidationError` on a schema
 * violation, an unknown standard id or a non-semver version, so a stale or mistyped dataset fails at load time.
 */
export function loadMappingDataset(raw: unknown): MappingDataset {
  const result = mappingDatasetSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = (issue?.path ?? []).map(String).join('.') || '(root)';
    throw new ValidationError('invalid finding mapping dataset', {
      detail: `mapping dataset ${where}: ${issue?.message ?? 'invalid'}`,
    });
  }
  return Object.freeze(result.data);
}

/** The shipped dataset (version 1.0.0). Loading it validates every entry against the pinned id lists. */
export const DEFAULT_MAPPING_DATASET: MappingDataset = loadMappingDataset(mappings100);
