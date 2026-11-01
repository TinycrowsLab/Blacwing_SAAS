import { z } from 'zod';

import { isoDateTimeSchema } from './primitives.js';

/**
 * The tool manifest baked into bw-sandbox at `/etc/bw/tool-manifest.json` (IMAGE-008, #606). It records exactly which
 * tools, versions and checksums a sandbox image carries, so every run can stamp them onto its run manifest (S8.9).
 * The image build (infra/docker/sandbox/tools/gen-manifest.mjs) produces it from tools.pin.json and scanners.pin.json
 * after re-hashing each installed binary, and it is byte-stable for identical inputs.
 */

/** Where the image stores the manifest; the runtime reads it from here. */
export const TOOL_MANIFEST_PATH = '/etc/bw/tool-manifest.json';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const DIGITS = /^\d+$/;
const TOOL_NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** One bundled tool: its exact version, the sha256 of the installed binary, its licence and project source. */
export const toolManifestEntrySchema = z
  .object({
    name: z.string().regex(TOOL_NAME),
    version: z.string().min(1),
    sha256: z.string().regex(SHA256_HEX),
    licence: z.string().min(1),
    source: z.url({ protocol: /^https$/ }),
  })
  .strict();

export type ToolManifestEntry = z.infer<typeof toolManifestEntrySchema>;

/**
 * The full manifest. `tools` is sorted by name and free of duplicates, so the list has one canonical order.
 * `imageDigest` is null until the image is published (IMAGE-012 fills it with the full image digest reference).
 */
export const toolManifestSchema = z
  .object({
    imageBaseDigest: z.string().regex(SHA256_DIGEST),
    imageDigest: z.string().regex(SHA256_DIGEST).nullable(),
    generatedAt: isoDateTimeSchema,
    tools: z.array(toolManifestEntrySchema).min(1),
    nucleiTemplatesCommit: z.string().regex(COMMIT_SHA),
    playwrightVersion: z.string().regex(SEMVER),
    chromiumRevision: z.string().regex(DIGITS),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const names = manifest.tools.map((tool) => tool.name);
    names.forEach((name, index) => {
      if (index > 0 && (names[index - 1] ?? '') >= name) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', index, 'name'],
          message: 'tools must be sorted by name with no duplicates',
        });
      }
    });
  });

export type ToolManifest = z.infer<typeof toolManifestSchema>;

/**
 * Parses an untrusted manifest (the file at {@link TOOL_MANIFEST_PATH}, or a copy stamped onto a run). Throws a
 * ZodError on any deviation, so a malformed or tampered manifest never reaches a run record.
 */
export function parseToolManifest(input: unknown): ToolManifest {
  return toolManifestSchema.parse(input);
}
