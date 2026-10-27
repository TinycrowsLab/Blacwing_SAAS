/**
 * The tool error contract (MCP-001, #666). A tool never throws to the model: every outcome is
 * `{ ok: true, data }` or `{ ok: false, code, message }` with one of these stable codes.
 */
export const TOOL_ERROR_CODES = [
  'TOOL_SCOPE_DENIED',
  'TOOL_BUDGET_EXCEEDED',
  'TOOL_BACKEND_UNAVAILABLE',
  'TOOL_INVALID_INPUT',
  'TOOL_KILLED',
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolFailure {
  readonly ok: false;
  readonly code: ToolErrorCode;
  /** Safe for the model and the audit trail: never a stack, a token or a backend response body. */
  readonly message: string;
}

export type ToolResult<T> = { readonly ok: true; readonly data: T } | ToolFailure;

/** Thrown by helpers (the broker client) and mapped to a {@link ToolFailure} by the wrapper. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function toolFailure(code: ToolErrorCode, message: string): ToolFailure {
  return { ok: false, code, message };
}
