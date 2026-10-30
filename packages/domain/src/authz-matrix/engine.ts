import { z } from 'zod';

import {
  type AccessMatrixVerdict,
  type AccessOutcome,
  classifyAccessResponse,
  evaluateAccessMatrixCell,
  type RecordedResponse,
} from './classify.js';
import {
  type AuthorisationMatrix,
  AuthzMatrixError,
  type ControlSelector,
  type ExpectedAccess,
  NEGATIVE_CONTROL_TEMPLATES,
  projectMatrix,
  selectControlRole,
} from './model.js';

import type { RoleSessionStatus } from '@blackwing/contracts';

/**
 * The authorisation-matrix execution engine (AUTHLOGIC-003, #697; F9, F14, F16). It walks the role × function
 * (× object) grid of one matrix, replays each cell with the acting role's session, classifies the outcome with
 * the AUTHLOGIC-002 classifier and evaluates it against the declared expectation.
 *
 * The engine performs no IO of its own. The gateway call (`replay`) and the session checks are injected ports, so
 * the same deterministic logic runs in the worker, in tests and in the Validator replay. Invariants:
 * - reads only: a function whose method is not GET, HEAD or OPTIONS is recorded as `skipped` and never sent;
 *   a function that names only an operation id has no known method and is skipped the same way (fail closed);
 * - a request budget covers every request the engine sends (replays, 429 retries and negative controls); a run
 *   that cannot pay for its next request stops at that cell and reports `nextOffset` so the next chunk resumes there;
 * - the kill switch is an `AbortSignal`, checked before every cell; an aborted run stops without sending more;
 * - the engine records role ids and evidence refs only, never the response body or any credential.
 */

/** The methods the engine may replay. Anything else is a write and is deferred to the gated path. */
export const AUTHZ_READ_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;
export type AuthzReadMethod = (typeof AUTHZ_READ_METHODS)[number];

const READ_METHODS: ReadonlySet<string> = new Set(AUTHZ_READ_METHODS);

/** Narrows a matrix method to the read-only subset the engine may send. */
function isReadMethod(method: string): method is AuthzReadMethod {
  return READ_METHODS.has(method);
}

/** HTTP status the engine treats as rate limiting: it backs off and retries within the budget. */
export const AUTHZ_RATE_LIMITED_STATUS = 429;

/** Why a cell was skipped without sending a request. Stable codes, so the audit trail can group them. */
export const AUTHZ_SKIP_REASONS = {
  writeMethod: 'write_method_deferred',
  noReadMethod: 'no_read_method',
} as const;

/** One replay as the gateway performs it: the acting role, the function and the object, read-only. */
export interface AuthzReplayRequest {
  readonly roleId: string;
  readonly functionId: string;
  readonly objectId?: string;
  readonly method: AuthzReadMethod;
  readonly pathTemplate: string;
}

/** The gateway's answer: the recorded response and the reference to the evidence it captured (no body, no secret). */
export interface AuthzReplayResult {
  readonly response: RecordedResponse;
  readonly evidenceRef: string;
}

/** The ports the engine needs. All IO sits behind them, so the engine stays pure and replayable. */
export interface AuthzEnginePorts {
  /** Live status of a role session, as the session manager reports it. */
  readonly sessionStatus: (roleId: string) => Promise<RoleSessionStatus>;
  /** Asks the session manager to refresh an expired session. Omitted means no refresh is attempted. */
  readonly refreshSession?: (roleId: string) => Promise<RoleSessionStatus>;
  /** Sends one read-only request under the role's session, through the egress gateway. */
  readonly replay: (request: AuthzReplayRequest) => Promise<AuthzReplayResult>;
  /** Waits before a 429 retry. Injected so tests and the Validator replay need no real delay. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called once per cell, in grid order. The audit and metrics hook; it receives role ids, never bodies. */
  readonly onCell?: (cell: AuthzCellResult) => void;
}

export interface AuthzEngineOptions {
  /** Index of the first grid cell to run (a chunk resumes from `nextOffset` of the previous chunk). */
  readonly offset?: number;
  /** The most grid cells this chunk covers. Omitted means the rest of the grid. */
  readonly limit?: number;
  /** Requests the run may send in total: replays, 429 retries and negative controls. */
  readonly maxRequests: number;
  /** Retries per request after a 429. Each retry is a request and spends budget. Defaults to 2. */
  readonly maxRetries?: number;
  /** Base backoff before a 429 retry, doubled per attempt. Defaults to 500 ms. */
  readonly backoffMs?: number;
  /** The kill switch. Checked before every cell; an aborted run sends nothing further. */
  readonly signal?: AbortSignal;
}

const MAX_RETRIES_CEILING = 10;
const BACKOFF_MS_CEILING = 60_000;

const optionsSchema = z.object({
  offset: z.int().min(0).optional(),
  limit: z.int().min(1).optional(),
  maxRequests: z.int().min(0),
  maxRetries: z.int().min(0).max(MAX_RETRIES_CEILING).optional(),
  backoffMs: z.int().min(0).max(BACKOFF_MS_CEILING).optional(),
});

export interface AuthzCellResult {
  readonly roleId: string;
  readonly functionId: string;
  readonly objectId?: string;
  readonly expected: ExpectedAccess | 'unknown';
  /** A verdict from the evaluator, or `skipped` when no request was sent for the cell. */
  readonly verdict: AccessMatrixVerdict | 'skipped';
  /** The evaluator's reason code, or the skip reason. */
  readonly reason: string;
  /** The acting role's classified outcome. Undefined when no request reached the target. */
  readonly actual?: AccessOutcome;
  /** The negative control's classified outcome. Undefined when no control ran. */
  readonly control?: AccessOutcome;
  /** The role that served as the negative control, when one was needed and selected. */
  readonly controlRoleId?: string;
  /** True for a candidate access-control issue the class modules pick up: a violation or a mismatch. */
  readonly flagged: boolean;
  /** Evidence references from the gateway, acting request first, then control. */
  readonly evidenceRefs: readonly string[];
}

export interface AuthzRunCounts {
  /** Cells whose acting request was sent (`authz_cells_executed_total`). */
  readonly executed: number;
  /** Cells whose actual access differed from the expectation in the flagged direction (`authz_cells_mismatch_total`). */
  readonly mismatch: number;
  /** Cells whose acting outcome was ambiguous (`authz_cells_ambiguous_total`). */
  readonly ambiguous: number;
  /** Cells flagged as candidate access-control issues (violation or mismatch). */
  readonly flagged: number;
  /** Cells the evaluator reported as blocked (no live session). */
  readonly blocked: number;
  /** Cells skipped without a request (writes or no read method). */
  readonly skipped: number;
}

export interface AuthzRunResult {
  readonly matrixVersion: number;
  readonly cells: readonly AuthzCellResult[];
  readonly counts: AuthzRunCounts;
  /** The first grid index this chunk did not evaluate. Equal to the grid length when the run is complete. */
  readonly nextOffset: number;
  readonly complete: boolean;
  readonly aborted: boolean;
  readonly budgetExhausted: boolean;
  readonly requestsUsed: number;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;

/** Stops the run with a stable error when the caller passes a malformed budget or chunk. */
function parseOptions(options: AuthzEngineOptions): z.output<typeof optionsSchema> {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new AuthzMatrixError(
      `authz engine options are invalid: ${parsed.error.issues[0]?.message ?? 'unknown issue'}`,
    );
  }
  return parsed.data;
}

const noSleep = (): Promise<void> => Promise.resolve();

/**
 * The negative control for one cell (F16): the object's owner when the object has one, otherwise an allowed peer on
 * the same function. Projection puts an object on every cell once the matrix declares objects, so the owner is
 * tried first and a function-level peer is the fallback.
 */
function selectNegativeControl(
  matrix: AuthorisationMatrix,
  selector: ControlSelector,
): string | undefined {
  if (selector.objectId !== undefined) {
    const owner = selectControlRole(matrix, NEGATIVE_CONTROL_TEMPLATES.object_access, selector);
    if (owner !== undefined) return owner;
  }
  return selectControlRole(matrix, NEGATIVE_CONTROL_TEMPLATES.function_access, selector);
}

/** A live session, after one refresh when the port allows it. Anything else is not live. */
async function liveSession(roleId: string, ports: AuthzEnginePorts): Promise<RoleSessionStatus> {
  const status = await ports.sessionStatus(roleId);
  if (status === 'live' || ports.refreshSession === undefined) return status;
  return ports.refreshSession(roleId);
}

interface RunState {
  remaining: number;
  requestsUsed: number;
}

/**
 * Sends one request, retrying a 429 with exponential backoff while retries and budget remain. Every attempt is a
 * request and is charged to the budget. Returns `undefined` when the budget cannot pay for the next attempt.
 */
async function replayWithBackoff(
  request: AuthzReplayRequest,
  ports: AuthzEnginePorts,
  state: RunState,
  retry: { maxRetries: number; backoffMs: number },
): Promise<AuthzReplayResult | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    if (state.remaining <= 0) return undefined;
    state.remaining -= 1;
    state.requestsUsed += 1;
    const result = await ports.replay(request);
    const rateLimited = result.response.status === AUTHZ_RATE_LIMITED_STATUS;
    if (!rateLimited || attempt >= retry.maxRetries) return result;
    await (ports.sleep ?? noSleep)(retry.backoffMs * 2 ** attempt);
  }
}

/**
 * Runs one chunk of the matrix grid. Cells are walked in the projected order (role, then function, then object),
 * so a run is deterministic and a chunk can be resumed from `nextOffset`.
 */
export async function runAuthzMatrix(
  matrix: AuthorisationMatrix,
  ports: AuthzEnginePorts,
  options: AuthzEngineOptions,
): Promise<AuthzRunResult> {
  const parsed = parseOptions(options);
  const grid = projectMatrix(matrix);
  const functions = new Map(matrix.functions.map((fn) => [fn.id, fn]));
  const start = parsed.offset ?? 0;
  const end = Math.min(grid.length, start + (parsed.limit ?? grid.length));
  const retry = {
    maxRetries: parsed.maxRetries ?? DEFAULT_MAX_RETRIES,
    backoffMs: parsed.backoffMs ?? DEFAULT_BACKOFF_MS,
  };
  const state: RunState = { remaining: parsed.maxRequests, requestsUsed: 0 };
  const cells: AuthzCellResult[] = [];
  let nextOffset = start;
  let aborted = false;
  let budgetExhausted = false;

  const record = (cell: AuthzCellResult): void => {
    cells.push(cell);
    ports.onCell?.(cell);
  };

  for (let index = start; index < end; index += 1) {
    if (options.signal?.aborted === true) {
      aborted = true;
      break;
    }
    const cell = grid[index];
    const fn = cell === undefined ? undefined : functions.get(cell.functionId);
    if (cell === undefined || fn === undefined) {
      throw new AuthzMatrixError(`grid cell ${index} has no function`);
    }
    const base = {
      roleId: cell.roleId,
      functionId: cell.functionId,
      ...(cell.objectId === undefined ? {} : { objectId: cell.objectId }),
      expected: cell.expected,
    };

    if (!('method' in fn)) {
      record({
        ...base,
        verdict: 'skipped',
        reason: AUTHZ_SKIP_REASONS.noReadMethod,
        flagged: false,
        evidenceRefs: [],
      });
      nextOffset = index + 1;
      continue;
    }
    if (!isReadMethod(fn.method)) {
      record({
        ...base,
        verdict: 'skipped',
        reason: AUTHZ_SKIP_REASONS.writeMethod,
        flagged: false,
        evidenceRefs: [],
      });
      nextOffset = index + 1;
      continue;
    }

    const sessionStatus = await liveSession(cell.roleId, ports);
    if (sessionStatus !== 'live') {
      const verdict = evaluateAccessMatrixCell({
        expected: cell.expected,
        sessionStatus,
        actual: 'ambiguous',
      });
      record({
        ...base,
        verdict: verdict.verdict,
        reason: verdict.reason,
        flagged: false,
        evidenceRefs: [],
      });
      nextOffset = index + 1;
      continue;
    }

    const acting = await replayWithBackoff(
      {
        roleId: cell.roleId,
        functionId: cell.functionId,
        ...(cell.objectId === undefined ? {} : { objectId: cell.objectId }),
        method: fn.method,
        pathTemplate: fn.pathTemplate,
      },
      ports,
      state,
      retry,
    );
    if (acting === undefined) {
      budgetExhausted = true;
      break;
    }
    const actual = classifyAccessResponse(acting.response);
    const evidenceRefs = [acting.evidenceRef];

    let control: AccessOutcome | undefined;
    let controlRoleId: string | undefined;
    if (cell.expected === 'deny' && actual === 'allow') {
      controlRoleId = selectNegativeControl(matrix, {
        functionId: cell.functionId,
        ...(cell.objectId === undefined ? {} : { objectId: cell.objectId }),
        actingRole: cell.roleId,
      });
      if (controlRoleId !== undefined && (await liveSession(controlRoleId, ports)) === 'live') {
        const controlReplay = await replayWithBackoff(
          {
            roleId: controlRoleId,
            functionId: cell.functionId,
            ...(cell.objectId === undefined ? {} : { objectId: cell.objectId }),
            method: fn.method,
            pathTemplate: fn.pathTemplate,
          },
          ports,
          state,
          retry,
        );
        if (controlReplay !== undefined) {
          control = classifyAccessResponse(controlReplay.response);
          evidenceRefs.push(controlReplay.evidenceRef);
        }
      }
    }

    const evaluation = evaluateAccessMatrixCell({
      expected: cell.expected,
      sessionStatus: 'live',
      actual,
      control,
    });
    record({
      ...base,
      verdict: evaluation.verdict,
      reason: evaluation.reason,
      actual,
      ...(control === undefined ? {} : { control }),
      ...(controlRoleId === undefined ? {} : { controlRoleId }),
      flagged: evaluation.verdict === 'violation' || evaluation.verdict === 'mismatch',
      evidenceRefs,
    });
    nextOffset = index + 1;
  }

  const count = (predicate: (cell: AuthzCellResult) => boolean): number =>
    cells.filter((cell) => predicate(cell)).length;
  return {
    matrixVersion: matrix.version,
    cells,
    counts: {
      executed: count((cell) => cell.actual !== undefined),
      mismatch: count((cell) => cell.verdict === 'mismatch'),
      ambiguous: count((cell) => cell.actual === 'ambiguous'),
      flagged: count((cell) => cell.flagged),
      blocked: count((cell) => cell.verdict === 'blocked'),
      skipped: count((cell) => cell.verdict === 'skipped'),
    },
    nextOffset,
    complete: nextOffset >= grid.length,
    aborted,
    budgetExhausted,
    requestsUsed: state.requestsUsed,
  };
}
