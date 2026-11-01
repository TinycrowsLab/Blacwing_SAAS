import { z } from 'zod';

import {
  MENTOR_SUMMARY_DEFAULT_MAX_CHARS,
  MENTOR_SUMMARY_MAX_MAX_CHARS,
  MENTOR_SUMMARY_MIN_MAX_CHARS,
} from '@blackwing/config';
import { ValidationError } from '@blackwing/errors';
import { redactText } from '@blackwing/logger';

import { hashToolArgs } from './normalise.js';
import { createNoOpSummaryObserver, type MentorSummaryObserver } from './summary-observer.js';

import type { StallDetector, StallReason, StallSignal } from './stall-detector.js';
import type { StallWindow, ToolEvent } from './stall-window.js';

/**
 * Bounded, redacted, structured summary of a stalled session for the mentor (MENTOR-002, #421, advances F12).
 * The mentor reasons over this instead of replaying the transcript. Actions and errors come from deterministic
 * extraction (the mentor's value is pattern-breaking advice, and a faithful action list beats a lossy
 * re-narration). Only the narrative `openGoal` may come from a model, through an injected narrator, and it
 * falls back to the planner's objective when the narrator fails or stalls.
 *
 * Every string passes through the `@blackwing/logger` redactor (registered secret values and credential shapes)
 * before it can leave this function. Target-derived text (errors, last known state, a narrated goal) is fenced as
 * untrusted data (CONTEXT_PACK §4.5, §8.7). Output is bounded by the serialised character budget; the oldest
 * actions and errors are dropped first and the drops are reported.
 */

/** Largest number of turns a caller may ask the archive for. Bounds the read. */
export const MENTOR_SUMMARY_MAX_WINDOW_TURNS = 200;
/** Newest actions kept before the character budget applies. */
const MAX_ACTIONS = 100;
/** Newest errors kept before the character budget applies. */
const MAX_ERRORS = 20;
/** Longest single error entry, in characters, before fencing. */
const MAX_ERROR_CHARS = 300;
/** Longest tool output or assistant text read from one record, in characters. */
const MAX_RECORD_CHARS = 256_000;
/** Longest tool name accepted from the archive. */
const MAX_TOOL_NAME_CHARS = 128;
/** Deadline for the optional narrator; past it the objective stands in for `openGoal`. */
const NARRATOR_DEADLINE_MS = 10_000;

const BINARY_ELIDED = '[binary output elided]';
const UNTRUSTED_OPEN = '<untrusted_target_data>';
const UNTRUSTED_CLOSE = '</untrusted_target_data>';
const UNTRUSTED_CLOSE_ESCAPED = '<\\/untrusted_target_data';
const REDACTED_MARK_PATTERN = /\[REDACTED\]/g;
/** Code units of the binary-content scan. Tab, LF and CR are text; other C0 and C1 controls are not. */
const CODE = {
  TAB: 0x09,
  LF: 0x0a,
  CR: 0x0d,
  UNIT_SEPARATOR: 0x1f,
  DEL: 0x7f,
  C1_END: 0x9f,
  REPLACEMENT: 0xfffd,
  HIGH_START: 0xd800,
  HIGH_END: 0xdbff,
  LOW_START: 0xdc00,
  LOW_END: 0xdfff,
} as const;
/** Longest timestamp accepted from an archive record. */
const MAX_TIMESTAMP_CHARS = 64;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const outcomeSchema = z.enum(['ok', 'error', 'denied']);

/** One archived record. The archive adapter (RUNTIME) writes these; they are validated again here. */
export const transcriptRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tool'),
    at: z.string().min(1).max(MAX_TIMESTAMP_CHARS),
    tool: z.string().min(1).max(MAX_TOOL_NAME_CHARS),
    args: z.unknown(),
    outcome: outcomeSchema,
    /** Tool output for a failed call. Raw bytes are decoded as UTF-8 or elided when they are not valid UTF-8. */
    errorOutput: z
      .union([
        z.string().max(MAX_RECORD_CHARS),
        z.custom<Uint8Array>((v) => v instanceof Uint8Array),
      ])
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('assistant'),
    at: z.string().min(1).max(MAX_TIMESTAMP_CHARS),
    text: z.string().max(MAX_RECORD_CHARS),
  }),
]);
export type TranscriptRecord = z.output<typeof transcriptRecordSchema>;

/**
 * Port to the archived transcript owned by RUNTIME. `recent` returns the records of the last `turns` turns of one
 * session, oldest first. It throws when the store is unavailable; the summariser then falls back to telemetry.
 */
export interface TranscriptArchive {
  recent(sessionId: string, turns: number): Promise<readonly TranscriptRecord[]>;
}

/**
 * Optional model narrator for `openGoal`. Callers route it through the model gateway with the session's virtual
 * key. It receives only scrubbed text and must not be given tool arguments.
 */
export interface GoalNarrator {
  narrate(input: { readonly objective: string; readonly lastKnownState: string }): Promise<string>;
}

export interface MentorAction {
  readonly tool: string;
  /** SHA-256 of the normalised arguments (MENTOR-001). The raw arguments never reach the summary. */
  readonly normalisedArgsHash: string;
  readonly outcome: 'ok' | 'error' | 'denied';
}

/** Structured mentor input (MENTOR-002). Fenced fields are target-derived and must be read as data. */
export interface MentorInput {
  /** The planner's objective. Planner output, redacted, not fenced. */
  readonly objective: string;
  readonly recentActions: readonly MentorAction[];
  /** Fenced, one per failed or denied call, oldest first. */
  readonly errors: readonly string[];
  /** Fenced last observed state, or empty when no transcript was readable. */
  readonly lastKnownState: string;
  /** Fenced narrative goal when a narrator produced one, otherwise the objective. */
  readonly openGoal: string;
  readonly stallReasons: readonly StallReason[];
  /** The stall signal that invoked the mentor, so it sees why. */
  readonly stall: StallSignal;
  /** False when the transcript could not be read and the summary is telemetry-only. */
  readonly transcriptAvailable: boolean;
  readonly truncated: {
    readonly actions: number;
    readonly errors: number;
    /** True when a text field was shortened to fit the budget. */
    readonly text: boolean;
  };
}

export interface MentorSummaryInput {
  readonly sessionId: string;
  /** The transcript window: the last `turns` turns. */
  readonly window: { readonly turns: number };
  /** The planner's objective for the session. */
  readonly objective: string;
  /** Live telemetry (MENTOR-001). Supplies the stall signal and the fallback actions. */
  readonly stallWindow: StallWindow;
  readonly detector: StallDetector;
  /** The archived transcript. Absent or unavailable means a telemetry-only summary. */
  readonly archive?: TranscriptArchive;
  readonly narrator?: GoalNarrator;
  /** Serialised budget in characters. Defaults to `MENTOR_SUMMARY_MAX_CHARS` (6000). */
  readonly maxChars?: number;
  readonly observer?: MentorSummaryObserver;
}

function resolveMaxChars(value: number | undefined): number {
  const max = value ?? MENTOR_SUMMARY_DEFAULT_MAX_CHARS;
  if (
    !Number.isInteger(max) ||
    max < MENTOR_SUMMARY_MIN_MAX_CHARS ||
    max > MENTOR_SUMMARY_MAX_MAX_CHARS
  ) {
    throw new ValidationError(
      `mentor summary maxChars must be an integer ${String(MENTOR_SUMMARY_MIN_MAX_CHARS)}..${String(MENTOR_SUMMARY_MAX_MAX_CHARS)}`,
    );
  }
  return max;
}

function resolveTurns(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MENTOR_SUMMARY_MAX_WINDOW_TURNS) {
    throw new ValidationError(
      `mentor summary window.turns must be an integer 1..${String(MENTOR_SUMMARY_MAX_WINDOW_TURNS)}`,
    );
  }
  return value;
}

/**
 * True when the text carries control characters, U+FFFD or an unpaired surrogate: the marks of binary data that
 * was decoded leniently. Tab, LF and CR are ordinary text.
 */
function isBinaryText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === CODE.TAB || code === CODE.LF || code === CODE.CR) continue;
    if (code <= CODE.UNIT_SEPARATOR || (code >= CODE.DEL && code <= CODE.C1_END)) return true;
    if (code === CODE.REPLACEMENT) return true;
    if (code >= CODE.HIGH_START && code <= CODE.HIGH_END) {
      const next = text.charCodeAt(i + 1);
      if (next < CODE.LOW_START || next > CODE.LOW_END) return true;
      i++;
      continue;
    }
    if (code >= CODE.LOW_START && code <= CODE.LOW_END) return true;
  }
  return false;
}

/** Decodes raw output and elides it when it is not UTF-8 text. */
function elide(value: string | Uint8Array | undefined): string {
  if (value === undefined) return '';
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = UTF8.decode(value);
    } catch {
      return BINARY_ELIDED;
    }
  }
  return isBinaryText(text) ? BINARY_ELIDED : text;
}

/** Shortens text to `max` code units without leaving a lone high surrogate at the cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= CODE.HIGH_START && last <= CODE.HIGH_END ? cut.slice(0, -1) : cut;
}

/** Wraps target-derived text as untrusted data. Any closing tag inside it is escaped so it cannot end the fence. */
export function fenceUntrusted(text: string): string {
  const escaped = text.replace(/<\/untrusted_target_data/gi, UNTRUSTED_CLOSE_ESCAPED);
  return `${UNTRUSTED_OPEN}${escaped}${UNTRUSTED_CLOSE}`;
}

/** Redacts with the logger's registry and counts each replaced secret for the metric. */
function createScrubber(): { scrub: (text: string) => string; redactions: () => number } {
  let count = 0;
  return {
    scrub(text) {
      const out = redactText(text);
      const before = text.match(REDACTED_MARK_PATTERN)?.length ?? 0;
      const after = out.match(REDACTED_MARK_PATTERN)?.length ?? 0;
      count += Math.max(0, after - before);
      return out;
    },
    redactions: () => count,
  };
}

async function readArchive(
  archive: TranscriptArchive | undefined,
  sessionId: string,
  turns: number,
): Promise<readonly TranscriptRecord[] | undefined> {
  if (archive === undefined) return undefined;
  try {
    const parsed = z
      .array(transcriptRecordSchema)
      .safeParse(await archive.recent(sessionId, turns));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('narrator deadline exceeded'));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

interface Draft {
  objective: string;
  actions: MentorAction[];
  errors: string[];
  lastKnownState: string;
  openGoal: string;
  openGoalNarrated: boolean;
  droppedActions: number;
  droppedErrors: number;
  textTruncated: boolean;
}

function render(draft: Draft, signal: StallSignal, transcriptAvailable: boolean): MentorInput {
  return {
    objective: draft.objective,
    recentActions: [...draft.actions],
    errors: draft.errors.map((entry) => fenceUntrusted(entry)),
    lastKnownState: draft.lastKnownState === '' ? '' : fenceUntrusted(draft.lastKnownState),
    openGoal: draft.openGoalNarrated ? fenceUntrusted(draft.openGoal) : draft.openGoal,
    stallReasons: signal.reasons,
    stall: signal,
    transcriptAvailable,
    truncated: {
      actions: draft.droppedActions,
      errors: draft.droppedErrors,
      text: draft.textTruncated,
    },
  };
}

const serialisedLength = (value: unknown): number => JSON.stringify(value).length;

/** The text field with the most characters, or undefined when all are empty. */
function longestTextField(draft: Draft): 'objective' | 'lastKnownState' | 'openGoal' | undefined {
  const fields = ['objective', 'lastKnownState', 'openGoal'] as const;
  let best: (typeof fields)[number] | undefined;
  for (const field of fields) {
    if (draft[field].length === 0) continue;
    if (best === undefined || draft[field].length > draft[best].length) best = field;
  }
  return best;
}

/**
 * Builds the bounded mentor input for one stalled session (MENTOR-002, #421). Pure apart from the archive read,
 * the optional narrator and the observer callback. Deterministic for a fixed transcript: no clock is read.
 */
export async function summariseForMentor(input: MentorSummaryInput): Promise<MentorInput> {
  const maxChars = resolveMaxChars(input.maxChars);
  const turns = resolveTurns(input.window.turns);
  const observer = input.observer ?? createNoOpSummaryObserver();
  const signal = input.detector.evaluate(input.stallWindow);
  const scrubber = createScrubber();

  const objective = scrubber.scrub(input.objective);
  const records = await readArchive(input.archive, input.sessionId, turns);

  let actions: MentorAction[];
  let errors: string[];
  let lastKnownState = '';
  if (records !== undefined) {
    actions = [];
    errors = [];
    for (const record of records) {
      if (record.kind !== 'tool') continue;
      const tool = scrubber.scrub(record.tool);
      actions.push({
        tool,
        normalisedArgsHash: hashToolArgs(record.args),
        outcome: record.outcome,
      });
      if (record.outcome !== 'ok') {
        const detail = elide(record.errorOutput);
        const entry = scrubber.scrub(`${tool} ${record.outcome}: ${detail}`);
        errors.push(clip(entry, MAX_ERROR_CHARS));
      }
    }
    const last = records.at(-1);
    if (last?.kind === 'assistant') {
      lastKnownState = clip(scrubber.scrub(elide(last.text)), MAX_RECORD_CHARS);
    } else if (last?.kind === 'tool') {
      lastKnownState = scrubber.scrub(`${last.tool} ${last.outcome}`);
    }
  } else {
    // Telemetry-only: the stall window has tool calls with their digests and error kinds, and no output text.
    const tools = input.stallWindow.snapshot().filter((e): e is ToolEvent => e.kind === 'tool');
    actions = tools.map((e) => ({
      tool: scrubber.scrub(e.tool),
      normalisedArgsHash: e.argsHash,
      outcome: e.outcome,
    }));
    errors = tools
      .filter((e) => e.outcome !== 'ok')
      .map((e) =>
        clip(
          scrubber.scrub(
            `${e.tool} ${e.outcome}${e.errorKind === undefined ? '' : ` ${e.errorKind}`}`,
          ),
          MAX_ERROR_CHARS,
        ),
      );
  }

  const draft: Draft = {
    objective,
    actions: actions.slice(-MAX_ACTIONS),
    errors: errors.slice(-MAX_ERRORS),
    lastKnownState,
    openGoal: objective,
    openGoalNarrated: false,
    droppedActions: Math.max(0, actions.length - MAX_ACTIONS),
    droppedErrors: Math.max(0, errors.length - MAX_ERRORS),
    textTruncated: false,
  };

  if (input.narrator !== undefined) {
    try {
      const narrated = (
        await withDeadline(
          input.narrator.narrate({ objective, lastKnownState }),
          NARRATOR_DEADLINE_MS,
        )
      ).trim();
      if (narrated !== '') {
        draft.openGoal = clip(scrubber.scrub(narrated), MAX_RECORD_CHARS);
        draft.openGoalNarrated = true;
      }
    } catch {
      // The narrator is optional. The objective stands in, and the session is not blocked.
    }
  }

  const transcriptAvailable = records !== undefined;
  let out = render(draft, signal, transcriptAvailable);
  // Oldest actions drop first, then oldest errors.
  while (serialisedLength(out) > maxChars) {
    if (draft.actions.length > 0) {
      draft.actions.shift();
      draft.droppedActions += 1;
    } else if (draft.errors.length > 0) {
      draft.errors.shift();
      draft.droppedErrors += 1;
    } else {
      break;
    }
    out = render(draft, signal, transcriptAvailable);
  }
  // Still over budget: shorten the longest text field, halving each step, until the summary fits.
  while (serialisedLength(out) > maxChars) {
    const field = longestTextField(draft);
    if (field === undefined) break;
    draft[field] = draft[field].slice(0, Math.floor(draft[field].length / 2));
    draft.textTruncated = true;
    out = render(draft, signal, transcriptAvailable);
  }
  if (serialisedLength(out) > maxChars) {
    throw new ValidationError('mentor summary cannot fit its budget');
  }

  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  const truncated = out.truncated.actions > 0 || out.truncated.errors > 0 || out.truncated.text;
  observer.summarised({
    sessionId: input.sessionId,
    bytes,
    redactions: scrubber.redactions(),
    actionsCount: out.recentActions.length,
    truncated,
    transcriptAvailable,
  });
  return out;
}
