import { z } from 'zod';

import { isoDateTimeSchema } from '@blackwing/contracts';
import { ValidationError } from '@blackwing/errors';

import { hashToolArgs } from './normalise.js';

/**
 * Rolling window of session telemetry for the stall rules (MENTOR-001, #420). The window is fed from the
 * run-event stream (SDK lifecycle, partial messages, PreToolUse/PostToolUse hooks; CONTEXT_PACK §4.3). It is
 * in-memory only and writes nothing: the Run Controller owns persistence and reaction.
 *
 * Duplicates are removed on arrival: partial messages of one turn merge into one turn event, and a tool
 * call is counted once per `(turnId, toolUseId)`. Raw tool arguments are hashed on arrival and never kept.
 */

/** Largest window a caller may ask for; bounds memory and the O(n) scans in the rules. */
export const MAX_STALL_WINDOW_EVENTS = 2_000;
/** Default rolling size when the caller does not choose one. */
export const DEFAULT_STALL_WINDOW_EVENTS = 300;

/** Longest id accepted for session, turn, tool-use and subtask ids. */
const MAX_ID_LENGTH = 128;
/** Largest cost or progress count accepted from one event. */
const MAX_EVENT_VALUE = 1_000_000;
/** Longest error-kind label accepted. */
const MAX_ERROR_KIND_LENGTH = 64;

const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const nonNegativeCost = z.number().min(0).max(MAX_EVENT_VALUE);
const count = z.number().int().min(0).max(MAX_EVENT_VALUE);

const turnInputSchema = z.strictObject({
  kind: z.literal('turn'),
  turnId: idSchema,
  at: isoDateTimeSchema,
  costUsd: nonNegativeCost,
  /** New evidence items, subtask-status changes and new surface-model nodes seen in this turn. */
  progress: z.strictObject({
    evidence: count,
    subtaskChanges: count,
    surfaceNodes: count,
  }),
});

const toolInputSchema = z.strictObject({
  kind: z.literal('tool'),
  turnId: idSchema,
  toolUseId: idSchema,
  at: isoDateTimeSchema,
  tool: idSchema,
  args: z.unknown(),
  outcome: z.enum(['ok', 'error', 'denied']),
  /** Stable error class (for example `EGRESS_DENIED`). Compared, never shown. */
  errorKind: z.string().min(1).max(MAX_ERROR_KIND_LENGTH).optional(),
});

const subtaskInputSchema = z.strictObject({
  kind: z.literal('subtask'),
  at: isoDateTimeSchema,
  subtaskId: idSchema,
  status: z.enum(['started', 'completed']),
});

/** Input to {@link StallWindow.push}: the stream event as the caller parsed it. */
export const stallEventSchema = z.discriminatedUnion('kind', [
  turnInputSchema,
  toolInputSchema,
  subtaskInputSchema,
]);
export type StallEventInput = z.input<typeof stallEventSchema>;

/** One turn of the agent, after partial messages are merged. */
export interface TurnEvent {
  readonly kind: 'turn';
  readonly turnId: string;
  readonly at: string;
  readonly costUsd: number;
  readonly progress: {
    readonly evidence: number;
    readonly subtaskChanges: number;
    readonly surfaceNodes: number;
  };
}

/** One tool call. Holds the normalised argument digest, never the raw arguments. */
export interface ToolEvent {
  readonly kind: 'tool';
  readonly turnId: string;
  readonly toolUseId: string;
  readonly at: string;
  readonly tool: string;
  readonly argsHash: string;
  readonly outcome: 'ok' | 'error' | 'denied';
  readonly errorKind: string | undefined;
}

/** A subtask starting or completing. Both are progress markers. */
export interface SubtaskEvent {
  readonly kind: 'subtask';
  readonly at: string;
  readonly subtaskId: string;
  readonly status: 'started' | 'completed';
}

export type StallWindowEvent = TurnEvent | ToolEvent | SubtaskEvent;

/** Partial messages of one turn: progress and cost are monotonic, so the larger value wins. */
function mergeTurn(prev: TurnEvent, next: TurnEvent): TurnEvent {
  return {
    kind: 'turn',
    turnId: prev.turnId,
    at: prev.at <= next.at ? prev.at : next.at,
    costUsd: Math.max(prev.costUsd, next.costUsd),
    progress: {
      evidence: Math.max(prev.progress.evidence, next.progress.evidence),
      subtaskChanges: Math.max(prev.progress.subtaskChanges, next.progress.subtaskChanges),
      surfaceNodes: Math.max(prev.progress.surfaceNodes, next.progress.surfaceNodes),
    },
  };
}

export interface StallWindowOptions {
  /** Session the window belongs to. Carried to the observer for logs; never a metric label. */
  readonly sessionId: string;
  /** Rolling size. Oldest events drop first. */
  readonly maxEvents?: number;
}

/** Rolling, dedup-on-arrival window of stall events for one session. */
export class StallWindow {
  readonly sessionId: string;
  readonly maxEvents: number;
  private events: StallWindowEvent[] = [];

  constructor(options: StallWindowOptions) {
    if (options.sessionId.length === 0 || options.sessionId.length > MAX_ID_LENGTH) {
      throw new ValidationError(
        `stall window sessionId must be 1..${String(MAX_ID_LENGTH)} characters`,
      );
    }
    const max = options.maxEvents ?? DEFAULT_STALL_WINDOW_EVENTS;
    if (!Number.isInteger(max) || max < 1 || max > MAX_STALL_WINDOW_EVENTS) {
      throw new ValidationError(
        `stall window maxEvents must be an integer 1..${String(MAX_STALL_WINDOW_EVENTS)}`,
      );
    }
    this.sessionId = options.sessionId;
    this.maxEvents = max;
  }

  /**
   * Adds one event. Invalid input throws a ValidationError (fail closed: a malformed event never reaches
   * the rules). A duplicate turn merges; a duplicate tool call or subtask status is ignored.
   */
  push(input: StallEventInput): void {
    const parsed = stallEventSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `invalid stall event: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
    }
    const event = parsed.data;
    if (event.kind === 'turn') {
      this.upsertTurn(event);
    } else if (event.kind === 'tool') {
      const dup = this.events.some(
        (e) => e.kind === 'tool' && e.turnId === event.turnId && e.toolUseId === event.toolUseId,
      );
      if (!dup) {
        this.append({
          kind: 'tool',
          turnId: event.turnId,
          toolUseId: event.toolUseId,
          at: event.at,
          tool: event.tool,
          argsHash: hashToolArgs(event.args),
          outcome: event.outcome,
          errorKind: event.errorKind,
        });
      }
    } else {
      const dup = this.events.some(
        (e) => e.kind === 'subtask' && e.subtaskId === event.subtaskId && e.status === event.status,
      );
      if (!dup)
        this.append({
          kind: 'subtask',
          at: event.at,
          subtaskId: event.subtaskId,
          status: event.status,
        });
    }
  }

  /** Events in arrival order, oldest first. Read-only snapshot. */
  snapshot(): readonly StallWindowEvent[] {
    return this.events.slice();
  }

  private upsertTurn(event: z.output<typeof turnInputSchema>): void {
    const turn: TurnEvent = { ...event, progress: { ...event.progress } };
    const idx = this.events.findIndex((e) => e.kind === 'turn' && e.turnId === turn.turnId);
    const existing = this.events[idx];
    if (idx >= 0 && existing?.kind === 'turn') {
      this.events[idx] = mergeTurn(existing, turn);
    } else {
      this.append(turn);
    }
  }

  private append(event: StallWindowEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxEvents)
      this.events.splice(0, this.events.length - this.maxEvents);
  }
}
