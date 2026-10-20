// Lint fixture: an explicit `any` (expected: @typescript-eslint/no-explicit-any).
export function identity(value: any): string {
  return String(value);
}
