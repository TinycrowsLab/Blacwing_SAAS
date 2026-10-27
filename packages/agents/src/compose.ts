import { createHash } from 'node:crypto';

import { z } from 'zod';

import { parseSecretRef } from '@blackwing/contracts';

import { PREAMBLE_PLACEHOLDERS } from './base-preamble.js';
import { PERSONA_INTRUSIVENESS_CEILINGS } from './persona.js';
import { PromptError, type LoadedPrompt } from './prompt.js';

/**
 * Prompt composition (REGISTRY-004, CONTEXT_PACK §4.5 / §8.7 / §8.9).
 *
 * The system prompt is the base authorisation preamble (placeholders filled from the run envelope),
 * then the persona body, then the test-case brief. The preamble is guidance, not a control: scope and
 * intrusiveness are enforced deterministically elsewhere (§8.11). Credentials appear only as
 * `secret_ref` references, never values.
 */

export const DEFAULT_MAX_SYSTEM_PROMPT_BYTES = 65_536;

const LIMIT = { field: 512, list: 256, brief: 16_384 } as const;
const text = z.string().trim().min(1).max(LIMIT.field);
const textList = z.array(text).max(LIMIT.list);

/** Run/test-case context taken from the signed run envelope. Strict: unknown keys (e.g. secret values) are refused. */
export const runContextSchema = z.strictObject({
  saId: text,
  approverIdentity: text,
  assetScope: textList.min(1),
  testWindow: z.strictObject({ start: text, end: text }),
  maxIntrusiveness: z.enum(PERSONA_INTRUSIVENESS_CEILINGS),
  roles: textList,
  /** Free-text brief for the test case; target-derived content is untrusted data. */
  testCaseBrief: z.string().trim().max(LIMIT.brief).optional(),
  /** `bw-secret:` references only (§8.7). */
  credentialRefs: z
    .array(
      z.string().refine((v) => {
        try {
          parseSecretRef(v);
          return true;
        } catch {
          return false;
        }
      }, 'must be a secret_ref'),
    )
    .max(LIMIT.list)
    .optional(),
});
export type RunContext = z.input<typeof runContextSchema>;

export interface ComposedPrompt {
  readonly systemPrompt: string;
  readonly personaVersion: string;
  /** SHA-256 of the persona prompt body (REGISTRY-002). */
  readonly promptSha256: string;
  /** SHA-256 (hex) of `systemPrompt` as UTF-8; pinned per session (§8.9). */
  readonly composedSha256: string;
}

export interface ComposeOptions {
  /** The base preamble body (`_base`, REGISTRY-003) containing `{placeholder}` tokens. */
  readonly preamble: string;
  /** Overrides `BW_MAX_SYSTEM_PROMPT_BYTES` (default 65536). */
  readonly maxBytes?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Observability hook, e.g. `persona_prompt_composed_total{persona}`. */
  readonly onComposed?: (p: { persona: string }) => void;
}

function resolveMaxBytes(opts: ComposeOptions): number {
  if (opts.maxBytes !== undefined) {
    if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 1) {
      throw new PromptError('PROMPT_INVALID', 'PROMPT_INVALID: bad maxBytes');
    }
    return opts.maxBytes;
  }
  const raw = (opts.env ?? process.env).BW_MAX_SYSTEM_PROMPT_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_SYSTEM_PROMPT_BYTES;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    throw new PromptError('PROMPT_INVALID', 'PROMPT_INVALID: bad BW_MAX_SYSTEM_PROMPT_BYTES');
  }
  return n;
}

function missing(detail: string): PromptError {
  return new PromptError('PROMPT_PLACEHOLDER_MISSING', `PROMPT_PLACEHOLDER_MISSING: ${detail}`);
}

/**
 * Composes the system prompt. Fails closed (no partial result) on a missing/invalid run-context
 * field, a preamble lacking a required placeholder or holding an unknown one, or an oversized result.
 */
export function composePrompt(
  persona: Pick<LoadedPrompt, 'persona' | 'body' | 'version' | 'sha256'>,
  runContext: RunContext,
  opts: ComposeOptions,
): ComposedPrompt {
  const maxBytes = resolveMaxBytes(opts);
  const parsed = runContextSchema.safeParse(runContext);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const absent = issues.some((i) => i.code === 'invalid_type' && i.input === undefined);
    throw new PromptError(
      absent ? 'PROMPT_PLACEHOLDER_MISSING' : 'PROMPT_INVALID',
      `${absent ? 'PROMPT_PLACEHOLDER_MISSING' : 'PROMPT_INVALID'}: run context ${issues
        .map((i) => i.path.join('.'))
        .join(', ')}`,
      parsed.error,
    );
  }
  const ctx = parsed.data;
  const values: Record<(typeof PREAMBLE_PLACEHOLDERS)[number], string> = {
    saId: ctx.saId,
    assetScope: ctx.assetScope.join(', '),
    testWindow: `${ctx.testWindow.start} to ${ctx.testWindow.end}`,
    maxIntrusiveness: ctx.maxIntrusiveness,
    roles: ctx.roles.join(', '),
    approverIdentity: ctx.approverIdentity,
  };

  // Single pass: substituted values are never rescanned, so a value cannot inject a placeholder.
  const used = new Set<string>();
  const preamble = opts.preamble.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, key: string) => {
    if (!Object.hasOwn(values, key)) throw missing(`unknown placeholder ${token}`);
    used.add(key);
    return values[key as keyof typeof values];
  });
  const absentKeys = PREAMBLE_PLACEHOLDERS.filter((k) => !used.has(k));
  if (absentKeys.length > 0) throw missing(`preamble lacks ${absentKeys.join(', ')}`);

  const sections = [preamble.trimEnd(), persona.body.trimEnd()];
  if (ctx.testCaseBrief) sections.push(`## Test case brief\n${ctx.testCaseBrief}`);
  if (ctx.credentialRefs?.length) {
    sections.push(`## Credential references\n${ctx.credentialRefs.join('\n')}`);
  }
  const systemPrompt = `${sections.join('\n\n')}\n`;

  if (Buffer.byteLength(systemPrompt, 'utf8') > maxBytes) {
    throw new PromptError(
      'PROMPT_TOO_LARGE',
      `PROMPT_TOO_LARGE: composed prompt exceeds ${String(maxBytes)} bytes`,
    );
  }
  opts.onComposed?.({ persona: persona.persona });
  return {
    systemPrompt,
    personaVersion: persona.version,
    promptSha256: persona.sha256,
    composedSha256: createHash('sha256').update(systemPrompt, 'utf8').digest('hex'),
  };
}
