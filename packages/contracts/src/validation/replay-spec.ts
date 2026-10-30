import { z } from 'zod';

import { authorisableIntrusivenessSchema } from '../entities/authorisation.js';
import { LIMITS } from '../limits.js';
import { isBefore, isoDateTimeSchema, sha256HexSchema, uuidV7Schema } from '../primitives.js';
import { HTTP_METHODS } from '../scope.js';
import {
  evidenceRefSchema,
  OOB_WINDOW_MAX_MS,
  OracleBindingSchema,
  roleKeySchema,
} from './oracle.js';

/** Upper bounds that keep a replay spec small, reviewable and deterministic. */
export const MAX_REPLAY_STEPS = 50;
export const MAX_REPLAY_TARGETS = 100;
export const MAX_REPLAY_INPUT_REFS = 32;
/** Most model ids one run may pin. */
const MAX_PINNED_MODELS = 16;
/** Longest version string a pin may carry. */
const VERSION_MAX_LENGTH = 64;

const scriptIdSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/, 'must be a script id');
const versionSchema = z.string().min(1).max(VERSION_MAX_LENGTH);
export const hostnameSchema = z
  .string()
  .min(1)
  .max(LIMITS.hostnameMax)
  .regex(/^[A-Za-z0-9.-]+$/, 'must be a DNS name');

/** A target endpoint: the asset it belongs to and a URL template. Only absolute http(s) URLs pass. */
export const endpointRefSchema = z.strictObject({
  assetId: uuidV7Schema,
  urlTemplate: z
    .string()
    .min(1)
    .max(LIMITS.urlMax)
    .regex(/^https?:\/\//, 'must be an absolute http or https URL template'),
});
export type EndpointRef = z.infer<typeof endpointRefSchema>;

/**
 * One declarative replay step. `kind` selects a fixed shape; a step never carries an inline shell command or a
 * script body. Request bodies and other inputs are evidence references (`inputRef`) from `inputsRef`.
 */
export const replayStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('http_request'),
    method: z.enum(HTTP_METHODS),
    endpoint: endpointRefSchema,
    roleKey: roleKeySchema,
    inputRef: evidenceRefSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('tcp_probe'),
    host: hostnameSchema,
    port: z.int().min(1).max(LIMITS.portMax),
  }),
  z.strictObject({
    kind: z.literal('browser_action'),
    action: z.enum(['navigate', 'submit', 'wait']),
    endpoint: endpointRefSchema,
    roleKey: roleKeySchema,
    inputRef: evidenceRefSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('oob_check'),
    channel: z.enum(['dns', 'http']),
    windowMs: z.int().min(1).max(OOB_WINDOW_MAX_MS),
  }),
  z.strictObject({
    kind: z.literal('script'),
    scriptId: scriptIdSchema,
  }),
]);
export type ReplayStep = z.infer<typeof replayStepSchema>;

/** Every evidence reference a step names. */
function stepInputRefs(step: ReplayStep): string[] {
  return 'inputRef' in step && step.inputRef !== null ? [step.inputRef] : [];
}

/** The strategies that build a negative control (F16). Mirrors the catalogue's strategy set. */
export const NEGATIVE_CONTROL_STRATEGIES = [
  'benign_value',
  'unmodified_request',
  'unbound_interaction',
  'compliant_variant',
] as const;
export const negativeControlStrategySchema = z.enum(NEGATIVE_CONTROL_STRATEGIES);

/**
 * A parallel benign or known-safe variant. It must NOT satisfy the oracle (F16). It is required and must have at
 * least one step, so an empty control can never let a finding through.
 */
export const negativeControlSchema = z.strictObject({
  strategy: negativeControlStrategySchema,
  steps: z.array(replayStepSchema).min(1).max(MAX_REPLAY_STEPS),
});
export type NegativeControl = z.infer<typeof negativeControlSchema>;

/** The pinned environment of a replay (§8.9). Every replay records what ran, so a result can be reproduced. */
export const runPinsSchema = z.strictObject({
  modelIds: z.array(versionSchema).min(1).max(MAX_PINNED_MODELS),
  personaPromptHashes: z.record(roleKeySchema, sha256HexSchema),
  sdkVersion: versionSchema,
  claudeCodeVersion: versionSchema,
  sandboxImageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256 image digest'),
  toolVersions: z.record(roleKeySchema, versionSchema),
  nucleiTemplateCommit: z.string().regex(/^[0-9a-f]{40}$/, 'must be a full git commit id'),
  policyHash: sha256HexSchema,
  envelopeHash: sha256HexSchema,
  priceTableVersion: versionSchema,
});
export type RunPins = z.infer<typeof runPinsSchema>;

/**
 * The deterministic reproduction of one candidate: targets, declarative steps, the pre-declared oracle, the required
 * negative control and the pinned environment. Rules: the oracle is declared strictly before the test started
 * (post-hoc oracles are rejected); every referenced evidence input is listed in `inputsRef`.
 */
export const replaySpecSchema = z
  .strictObject({
    id: uuidV7Schema,
    candidateId: uuidV7Schema,
    testCaseId: uuidV7Schema,
    intrusivenessClass: authorisableIntrusivenessSchema,
    targets: z.array(endpointRefSchema).min(1).max(MAX_REPLAY_TARGETS),
    steps: z.array(replayStepSchema).min(1).max(MAX_REPLAY_STEPS),
    oracle: OracleBindingSchema,
    testStartedAt: isoDateTimeSchema,
    negativeControl: negativeControlSchema,
    pins: runPinsSchema,
    inputsRef: z.array(evidenceRefSchema).max(MAX_REPLAY_INPUT_REFS),
  })
  .superRefine((spec, ctx) => {
    if (!isBefore(spec.oracle.declaredAt, spec.testStartedAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['oracle', 'declaredAt'],
        message: 'the oracle must be declared before the test started (post-hoc oracle)',
      });
    }
    const declared = new Set(spec.inputsRef);
    const steps = [...spec.steps, ...spec.negativeControl.steps];
    for (const step of steps) {
      for (const ref of stepInputRefs(step)) {
        if (!declared.has(ref)) {
          ctx.addIssue({
            code: 'custom',
            path: ['inputsRef'],
            message: `input ${ref} is used by a step but not listed in inputsRef`,
          });
        }
      }
    }
  });
export type ReplaySpec = z.infer<typeof replaySpecSchema>;
