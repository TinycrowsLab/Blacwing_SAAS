// The standalone repro bundle contract (REPRO, F18): the format version, the `manifest.json` schema and the ordered
// request descriptors. The on-disk layout is documented in docs/architecture/repro-bundle-format.md. The runner
// (REPRO-004) and the verifier refuse any manifest whose `formatVersion` is not REPRO_FORMAT_VERSION.

import { z } from 'zod';

import { authorisableIntrusivenessSchema } from '../entities/authorisation.js';
import { LIMITS } from '../limits.js';
import { cweIdSchema, isoDateTimeSchema, sha256HexSchema } from '../primitives.js';
import { HTTP_METHODS } from '../scope.js';
import { evidenceRefSchema, OracleBindingSchema, oracleBindingTypeSchema } from './oracle.js';
import { negativeControlSchema, MAX_REPLAY_STEPS, runPinsSchema } from './replay-spec.js';

/** The bundle layout version. Bumped only by a change readers must notice; pinned in every manifest. */
export const REPRO_FORMAT_VERSION = '1.0';

/** Inline request bodies above this many bytes are stored as an evidence pointer instead (REPRO-002). */
export const REPRO_BODY_INLINE_MAX_BYTES = 262_144;

/** The placeholder a bundle writes in place of the target's scheme and host, so it replays against any target. */
export const REPRO_BASE_URL_PLACEHOLDER = '${TARGET_BASE_URL}';

/** The request headers a descriptor may carry. Anything else is refused, so an unknown header cannot smuggle a token. */
export const REPRO_HEADER_ALLOWLIST = [
  'accept',
  'accept-encoding',
  'accept-language',
  'content-length',
  'content-type',
  'origin',
  'referer',
  'user-agent',
  'x-requested-with',
] as const;

/** Credential-bearing headers. Refused by name, whatever the value (CONTEXT_PACK §8.7). */
export const REPRO_CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'] as const;

const MAX_REQUEST_HEADER_VALUE = 1_024;
/** The `${ROLE_<NAME>}` placeholder a request names instead of a session token. */
const rolePlaceholderSchema = z
  .string()
  .regex(/^\$\{ROLE_[A-Z][A-Z0-9_]{0,63}\}$/, 'must be a ${ROLE_...} placeholder');

/** A public id with the given prefix and the `@blackwing/ids` body (lowercase Crockford base32, 26 characters). */
const PUBLIC_ID_BODY = '[0-9abcdefghjkmnpqrstvwxyz]{26}';
const publicIdSchema = (prefix: 'fnd' | 'run' | 'asset') =>
  z.string().regex(new RegExp(`^${prefix}_${PUBLIC_ID_BODY}$`), `must be a ${prefix}_ public id`);

/** Declared oracle of the bundle: the same catalogue as `test_cases.oracle`, so an unknown type is refused at parse. */
const reproOracleSchema = z.strictObject({
  type: oracleBindingTypeSchema,
  params: z.record(z.string(), z.unknown()),
});

/** `manifest.json`. Minimal and additive; a new field needs a format-version bump only if readers must refuse it. */
export const ReproManifestSchema = z
  .strictObject({
    formatVersion: z.literal(REPRO_FORMAT_VERSION),
    findingPublicId: publicIdSchema('fnd'),
    runPublicId: publicIdSchema('run'),
    assetPublicId: publicIdSchema('asset'),
    class: authorisableIntrusivenessSchema,
    cweId: cweIdSchema.nullable(),
    owaspCategory: z.string().min(1).max(LIMITS.shortTextMax).nullable(),
    oracle: reproOracleSchema,
    negativeControl: negativeControlSchema,
    requestCount: z.int().min(1).max(MAX_REPLAY_STEPS),
    baseUrlPlaceholder: z.literal(REPRO_BASE_URL_PLACEHOLDER),
    pinned: z.strictObject({
      sandboxImageDigest: runPinsSchema.shape.sandboxImageDigest,
      toolVersions: runPinsSchema.shape.toolVersions,
      nucleiTemplateCommit: runPinsSchema.shape.nucleiTemplateCommit,
      formatVersion: z.literal(REPRO_FORMAT_VERSION),
    }),
    createdAt: isoDateTimeSchema,
    sanitised: z.boolean(),
    /** True when at least one request body is stored as an evidence pointer rather than inlined. */
    truncated: z.boolean(),
    /** SHA-256 over the bundle entries other than manifest.json, as documented in the format spec. */
    bundleSha256: sha256HexSchema,
  })
  .superRefine((manifest, ctx) => {
    // The oracle is checked against the replay catalogue. Its declaration time is the bundle's creation time.
    const oracle = OracleBindingSchema.safeParse({
      ...manifest.oracle,
      declaredAt: manifest.createdAt,
    });
    if (!oracle.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['oracle', 'params'],
        message: 'oracle params do not match the catalogue for this type',
      });
    }
  });
export type ReproManifest = z.infer<typeof ReproManifestSchema>;

/** Parses `manifest.json` and refuses any `formatVersion` the runner or verifier does not know (unknown → rejected). */
export function parseReproManifest(json: unknown): ReproManifest {
  return ReproManifestSchema.parse(json);
}

/** Headers of a request descriptor: allowlisted names only, no credential-bearing name, bounded values. */
const reproHeadersSchema = z
  .record(z.string(), z.string().max(MAX_REQUEST_HEADER_VALUE))
  .superRefine((headers, ctx) => {
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if ((REPRO_CREDENTIAL_HEADERS as readonly string[]).includes(lower)) {
        ctx.addIssue({
          code: 'custom',
          path: [name],
          message: 'credential-bearing headers are never stored in a bundle',
        });
      } else if (!(REPRO_HEADER_ALLOWLIST as readonly string[]).includes(lower)) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'header is not on the allowlist' });
      }
    }
  });

/** The request body: UTF-8 or base64 text inline, or an evidence pointer when it exceeds the inline cap. */
const reproBodySchema = z
  .strictObject({
    encoding: z.enum(['utf8', 'base64']),
    content: z.string().nullable(),
    evidenceRef: evidenceRefSchema.nullable(),
  })
  .superRefine((body, ctx) => {
    if ((body.content === null) === (body.evidenceRef === null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'a body is either inline content or an evidence reference, never both or neither',
      });
      return;
    }
    if (body.content === null) return;
    if (body.encoding === 'utf8') {
      if (new TextEncoder().encode(body.content).byteLength > REPRO_BODY_INLINE_MAX_BYTES) {
        ctx.addIssue({ code: 'custom', path: ['content'], message: 'inline body exceeds the cap' });
      }
      return;
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content)) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: 'must be canonical base64' });
      return;
    }
    // Decoded size of canonical base64: four characters carry three bytes, less the `=` padding.
    const BASE64_CHARS_PER_GROUP = 4;
    const BYTES_PER_GROUP = 3;
    const padding = body.content.endsWith('==') ? 2 : body.content.endsWith('=') ? 1 : 0;
    const decodedBytes = (body.content.length / BASE64_CHARS_PER_GROUP) * BYTES_PER_GROUP - padding;
    if (decodedBytes > REPRO_BODY_INLINE_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: 'inline body exceeds the cap' });
    }
  });

/**
 * One request descriptor, `requests/NNNN.json`. `index` is its 1-based position in the sequence and matches the
 * file name. The host is always the placeholder; the role is a placeholder, never a session token.
 */
export const ReproRequestDescriptorSchema = z.strictObject({
  index: z.int().min(1).max(MAX_REPLAY_STEPS),
  method: z.enum(HTTP_METHODS),
  url: z
    .string()
    .min(1)
    .max(LIMITS.urlMax)
    .regex(
      /^\$\{TARGET_BASE_URL\}\/[^\s]*$/,
      'must start with the ${TARGET_BASE_URL} placeholder and a path',
    ),
  headers: reproHeadersSchema,
  body: reproBodySchema.nullable(),
  roleName: rolePlaceholderSchema.nullable(),
});
export type ReproRequestDescriptor = z.infer<typeof ReproRequestDescriptorSchema>;
