import { z } from 'zod';

import { assetTypeSchema } from './entities/asset.js';

/**
 * Eval target manifests (EVAL-001, #796): one `eval/targets/<name>/target.json` per lab target the harness runs
 * against. The manifest pins the target by image digest (CONTEXT_PACK §8.9: runs never silently float), names
 * its compose service and loopback base URL, and holds only REFERENCES to credentials (§8.7). The eval tenant
 * seed and the runner read these through this schema, so a malformed manifest fails closed before anything runs.
 */

const EVAL_TARGET_SCHEMA_VERSION = 1;

/** Field bounds: titles, licence SPDX ids and notes, usernames, and the TCP port range. */
const TITLE_MAX = 120;
const TCP_PORT_MAX = 65535;
const SPDX_MAX = 64;
const NOTE_MAX = 500;
const ACCOUNT_MAX = 200;

/** Lower-case kebab name; it is also the directory name and the ground-truth file stem. */
const evalTargetNameSchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, 'lower-case kebab name');

/** An image reference that carries a sha256 digest. A bare tag is refused: runs must not float. */
const pinnedImageSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/,
    'image must be pinned by sha256 digest',
  );

/** Test modes. Grey-box is the primary mode for every target (CONTEXT_PACK §5 eval targets). */
const EVAL_TARGET_MODES = ['grey_box', 'black_box', 'white_box'] as const;
const evalTargetModeSchema = z.enum(EVAL_TARGET_MODES);

/** Spec formats a target can ship; the runner feeds them to the recon tools. */
const evalTargetSpecSchema = z.strictObject({
  kind: z.enum(['openapi', 'graphql_sdl']),
  /** Repo-relative path to the spec file, never absolute and never escaping the target directory. */
  path: z.string().regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/, 'relative path without ".."'),
});

/** A credential is a role plus a reference: the secret itself lives in OpenBao, never in the manifest (§8.7). */
const evalTargetCredentialSchema = z.strictObject({
  role: z.string().regex(/^[a-z][a-z_]{1,31}$/),
  username: z.string().min(1).max(ACCOUNT_MAX),
  secretRef: z
    .string()
    .regex(
      /^openbao:\/\/secret\/data\/eval\/targets\/[a-z][a-z0-9-]{1,39}\/[a-z][a-z0-9_-]{1,31}$/,
      'OpenBao KV v2 reference',
    ),
});

const loopbackHosts = new Set(['127.0.0.1', 'localhost']);

/** Where the image comes from: a registry image pinned by digest, or a local Dockerfile on a pinned base. */
const evalTargetSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('registry'), image: pinnedImageSchema }),
  z.strictObject({
    kind: z.literal('local'),
    dockerfile: z
      .string()
      .regex(/^eval\/targets\/[a-z0-9/-]+\/Dockerfile$/, 'Dockerfile under eval/targets'),
    baseImage: pinnedImageSchema,
  }),
]);

export const evalTargetSchema = z
  .strictObject({
    schemaVersion: z.literal(EVAL_TARGET_SCHEMA_VERSION),
    name: evalTargetNameSchema,
    title: z.string().min(1).max(TITLE_MAX),
    assetType: assetTypeSchema,
    /** Blackwing's own labs (true) versus the public open-source training apps (false). */
    synthetic: z.boolean(),
    source: evalTargetSourceSchema,
    /** The compose service name in the `targets` profile (`infra/compose/docker-compose.dev.yml`) or the eval compose. */
    service: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
    /** Container port the target listens on. */
    port: z.int().min(1).max(TCP_PORT_MAX),
    /** Loopback URL the harness reaches the target at (host port is the manifest's port override). */
    baseUrl: z
      .url()
      .refine((value) => loopbackHosts.has(new URL(value).hostname), 'baseUrl must be loopback'),
    modes: z.array(evalTargetModeSchema).min(1),
    primaryMode: evalTargetModeSchema,
    credentials: z.array(evalTargetCredentialSchema),
    specs: z.array(evalTargetSpecSchema),
    /** The vulnerability classes the target's ground truth covers (what the harness scores against). */
    classes: z.array(z.string().regex(/^[a-z][a-z_]{1,39}$/)).min(1),
    /** Repo-relative path to the ground-truth file (EVAL-002 owns the content). */
    groundTruth: z
      .string()
      .regex(/^eval\/ground-truth\/[a-z][a-z0-9-]{1,39}\.json$/, 'eval/ground-truth/<name>.json'),
    licence: z.strictObject({
      spdx: z.string().min(1).max(SPDX_MAX),
      upstream: z.url(),
      /** Eval-only: no target is ever redistributed in Blackwing's product image. */
      redistributed: z.literal(false),
      note: z.string().min(1).max(NOTE_MAX),
    }),
  })
  .superRefine((manifest, ctx) => {
    if (!manifest.modes.includes(manifest.primaryMode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryMode'],
        message: 'primaryMode must be one of modes',
      });
    }
    if (new Set(manifest.modes).size !== manifest.modes.length) {
      ctx.addIssue({ code: 'custom', path: ['modes'], message: 'modes must be unique' });
    }
    const roles = manifest.credentials.map((credential) => credential.role);
    if (new Set(roles).size !== roles.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['credentials'],
        message: 'credential roles must be unique',
      });
    }
    if (manifest.groundTruth !== `eval/ground-truth/${manifest.name}.json`) {
      ctx.addIssue({
        code: 'custom',
        path: ['groundTruth'],
        message: 'groundTruth must be eval/ground-truth/<name>.json',
      });
    }
    if (manifest.synthetic !== (manifest.source.kind === 'local')) {
      ctx.addIssue({
        code: 'custom',
        path: ['synthetic'],
        message: 'synthetic labs are built locally; public targets are pulled by digest',
      });
    }
  });
