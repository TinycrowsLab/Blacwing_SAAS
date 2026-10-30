import { z } from 'zod';

import { authorisableIntrusivenessSchema } from '../entities/authorisation.js';
import { LIMITS } from '../limits.js';
import { uuidV7Schema } from '../primitives.js';
import { reversalJournalPublicIdSchema } from '../reversal.js';
import { HTTP_METHODS } from '../scope.js';
import {
  evidenceRefSchema,
  nfcTextSchema,
  OOB_WINDOW_MAX_MS,
  OracleObservationSchema,
  roleKeySchema,
} from './oracle.js';
import {
  endpointRefSchema,
  hostnameSchema,
  MAX_REPLAY_INPUT_REFS,
  MAX_REPLAY_STEPS,
  MAX_REPLAY_TARGETS,
  type ReplaySpec,
} from './replay-spec.js';

/**
 * PoC-harness manifest (EXPLOIT-001, CONTEXT_PACK §8.3, §8.7, §8.9, §8.11). A deterministic, offline-replayable
 * descriptor of how to reproduce a candidate. It describes reproduction steps and the expected observation; it never
 * carries attack payloads, bypass recipes or free-form shell. The Validator's `ReplaySpec` is the narrower of the two:
 * `toReplaySpec` (EXPLOIT-005) converts a manifest into it.
 */

/** Largest serialised manifest accepted (64 KiB). Bulky inputs live in evidence and are referenced by `inputsRef`. */
const BYTES_PER_KIB = 1024;
const MANIFEST_KIB_MAX = 64;
export const POC_HARNESS_MANIFEST_MAX_BYTES = MANIFEST_KIB_MAX * BYTES_PER_KIB;
/** Most tools one harness may pin. */
const MAX_TOOLCHAIN = 16;
/** Most environment variables one harness may set. */
const MAX_ENV_ENTRIES = 32;
const ENV_VALUE_MAX = 512;
/** Keys whose names mark a secret. Such values never belong in a manifest (§8.7). */
const SECRET_LIKE_ENV_KEY = /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH|API_?KEY|PRIVATE/;

/**
 * A step handle or a workspace script id: a lowercase slug. An inline shell string, a path or a body cannot pass,
 * so a step is always a reference that a reviewer can read.
 */
const stepRefSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,63}$/, 'must be a step reference slug, never a command');

/** Parameters of each step kind. Strict: unknown keys (such as a `command`) are rejected. */
const httpRequestParamsSchema = z.strictObject({
  method: z.enum(HTTP_METHODS),
  endpoint: endpointRefSchema,
  roleKey: roleKeySchema,
  inputRef: evidenceRefSchema.nullable(),
});
const tcpProbeParamsSchema = z.strictObject({
  host: hostnameSchema,
  port: z.int().min(1).max(LIMITS.portMax),
});
const browserActionParamsSchema = z.strictObject({
  action: z.enum(['navigate', 'submit', 'wait']),
  endpoint: endpointRefSchema,
  roleKey: roleKeySchema,
  inputRef: evidenceRefSchema.nullable(),
});
const oobCheckParamsSchema = z.strictObject({
  channel: z.enum(['dns', 'http']),
  windowMs: z.int().min(1).max(OOB_WINDOW_MAX_MS),
});
/** A script step names a workspace script by `ref`; it carries no parameters and no body. */
const scriptParamsSchema = z.strictObject({});

/**
 * One declarative harness step. `kind` selects a fixed `params` shape. `ref` is the step handle, or for `script`
 * the id of a file in the sandbox workspace.
 */
export const harnessStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('http_request'),
    ref: stepRefSchema,
    params: httpRequestParamsSchema,
  }),
  z.strictObject({
    kind: z.literal('tcp_probe'),
    ref: stepRefSchema,
    params: tcpProbeParamsSchema,
  }),
  z.strictObject({
    kind: z.literal('browser_action'),
    ref: stepRefSchema,
    params: browserActionParamsSchema,
  }),
  z.strictObject({
    kind: z.literal('oob_check'),
    ref: stepRefSchema,
    params: oobCheckParamsSchema,
  }),
  z.strictObject({ kind: z.literal('script'), ref: stepRefSchema, params: scriptParamsSchema }),
]);
export type HarnessStep = z.infer<typeof harnessStepSchema>;

/** A tool the harness runs, pinned to an exact version and an exact image digest (§8.9). No ranges, no `latest`. */
export const pinnedToolSchema = z.strictObject({
  name: stepRefSchema,
  version: z
    .string()
    .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/, 'must be an exact version')
    .refine((version) => version !== 'latest', 'must not be the floating version latest'),
  imageDigestRef: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256 image digest'),
});
export type PinnedTool = z.infer<typeof pinnedToolSchema>;

/**
 * Environment for the harness. Keys are upper-case variable names. A key that names a secret is rejected, and a
 * value is NFC-normalised free text with no control characters.
 */
const envSchema = z
  .record(
    z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'must be an upper-case variable name'),
    nfcTextSchema(ENV_VALUE_MAX),
  )
  .refine((env) => Object.keys(env).length <= MAX_ENV_ENTRIES, 'too many environment variables')
  .refine(
    (env) => !Object.keys(env).some((key) => SECRET_LIKE_ENV_KEY.test(key)),
    'secret-like environment keys are not allowed; reference secrets instead (§8.7)',
  );

/**
 * The PoC-harness manifest. Rules: `destructive` is never a class (§8.3); a `state_changing` harness must name the
 * reversal-journal entry that undoes it; every evidence input a step names is listed in `inputsRef`; the whole
 * document is at most 64 KiB; and a tool must be pinned.
 */
export const PocHarnessManifestSchema = z
  .strictObject({
    id: uuidV7Schema,
    candidateId: uuidV7Schema,
    intrusivenessClass: authorisableIntrusivenessSchema,
    reversalRef: reversalJournalPublicIdSchema.nullable(),
    targets: z.array(endpointRefSchema).min(1).max(MAX_REPLAY_TARGETS),
    steps: z.array(harnessStepSchema).min(1).max(MAX_REPLAY_STEPS),
    expectedObservation: OracleObservationSchema,
    negativeControl: z.array(harnessStepSchema).min(1).max(MAX_REPLAY_STEPS),
    inputsRef: z.array(evidenceRefSchema).max(MAX_REPLAY_INPUT_REFS),
    toolchain: z
      .array(pinnedToolSchema)
      .min(1)
      .max(MAX_TOOLCHAIN)
      .refine(
        (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
        'each tool may be pinned only once',
      ),
    env: envSchema,
  })
  .superRefine((manifest, ctx) => {
    if (manifest.intrusivenessClass === 'state_changing' && manifest.reversalRef === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['reversalRef'],
        message: 'a state_changing harness must reference its reversal journal entry (§8.3)',
      });
    }

    const declared = new Set(manifest.inputsRef);
    for (const step of [...manifest.steps, ...manifest.negativeControl]) {
      const inputRef = 'inputRef' in step.params ? step.params.inputRef : null;
      if (inputRef !== null && !declared.has(inputRef)) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputsRef'],
          message: `input ${inputRef} is used by a step but not listed in inputsRef`,
        });
      }
    }

    if (JSON.stringify(manifest).length > POC_HARNESS_MANIFEST_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `the manifest exceeds ${POC_HARNESS_MANIFEST_MAX_BYTES} bytes; store large inputs as evidence`,
      });
    }
  });
export type PocHarnessManifest = z.infer<typeof PocHarnessManifestSchema>;

/**
 * The adapter signature (implemented in EXPLOIT-005). A manifest is the superset that narrows onto the Validator's
 * `ReplaySpec`; the fields the manifest does not carry (test case, test start, oracle declaration, pins) come from
 * the run that executes it.
 */
export type ToReplaySpec = (manifest: PocHarnessManifest) => ReplaySpec;
