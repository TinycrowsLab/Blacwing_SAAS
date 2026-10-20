// Lint fixture: a non-null assertion (expected: @typescript-eslint/no-non-null-assertion).
export function first(names: readonly string[]): string {
  return names[0]!;
}
