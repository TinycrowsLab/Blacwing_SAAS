// Lint fixture: dynamic code evaluation (expected: no-eval, no-new-func,
// @typescript-eslint/no-implied-eval).
export function evaluate(source: string): unknown {
  return eval(source);
}

export function compile(source: string): unknown {
  return new Function(source);
}

export function later(source: string): void {
  setTimeout(source, 1);
}
