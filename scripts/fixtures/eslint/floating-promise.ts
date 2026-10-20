// Lint fixture: a promise that is neither awaited nor handled, and an async function that never
// awaits (expected: @typescript-eslint/no-floating-promises, @typescript-eslint/require-await).
// Both rules need type information, so this fixture fails only when type-aware linting works.
export async function save(): Promise<number> {
  await Promise.resolve();
  return 1;
}

export async function noAwait(): Promise<string> {
  return 'done';
}

export function fireAndForget(): void {
  save();
}
