// Lint fixture: an implicit `any` (JSON.parse) leaking into typed code without validation
// (expected: @typescript-eslint/no-unsafe-assignment, no-unsafe-member-access, no-unsafe-call,
// no-unsafe-return). Type-aware rules only.
export function port(text: string): number {
  const config = JSON.parse(text);
  const value = config.server.port;
  config.reload();
  return value;
}
